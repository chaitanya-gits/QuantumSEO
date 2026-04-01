import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as elasticache from "aws-cdk-lib/aws-elasticache";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as opensearch from "aws-cdk-lib/aws-opensearchservice";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as sqs from "aws-cdk-lib/aws-sqs";
import * as lambdaEventSources from "aws-cdk-lib/aws-lambda-event-sources";
import { Construct } from "constructs";

export class SearchStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const vpc = new ec2.Vpc(this, "SearchVPC", { maxAzs: 2 });

    const crawlBucket = new s3.Bucket(this, "CrawlBucket", {
      versioned: true,
      lifecycleRules: [{ expiration: cdk.Duration.days(90) }],
    });

    const crawlDeadLetterQueue = new sqs.Queue(this, "CrawlDLQ");
    const crawlQueue = new sqs.Queue(this, "CrawlQueue", {
      visibilityTimeout: cdk.Duration.seconds(300),
      deadLetterQueue: {
        queue: crawlDeadLetterQueue,
        maxReceiveCount: 3,
      },
    });

    const opensearchDomain = new opensearch.Domain(this, "SearchDomain", {
      version: opensearch.EngineVersion.OPENSEARCH_2_9,
      capacity: {
        dataNodeInstanceType: "r6g.large.search",
        dataNodes: 2,
      },
      ebs: { volumeSize: 100, volumeType: ec2.EbsDeviceVolumeType.GP3 },
      zoneAwareness: { enabled: true },
      vpc,
    });

    new elasticache.CfnReplicationGroup(this, "SearchCache", {
      replicationGroupDescription: "Search result cache",
      cacheNodeType: "cache.r7g.large",
      numCacheClusters: 2,
      automaticFailoverEnabled: true,
    });

    const indexerFn = new lambda.DockerImageFunction(this, "IndexerFn", {
      code: lambda.DockerImageCode.fromImageAsset("./indexer"),
      memorySize: 2048,
      timeout: cdk.Duration.seconds(300),
      environment: {
        OPENSEARCH_URL: opensearchDomain.domainEndpoint,
        CRAWL_BUCKET: crawlBucket.bucketName,
      },
    });

    indexerFn.addEventSource(new lambdaEventSources.SqsEventSource(crawlQueue, { batchSize: 10 }));

    const cluster = new ecs.Cluster(this, "SearchCluster", { vpc });
    const taskDefinition = new ecs.FargateTaskDefinition(this, "SearchTaskDef", {
      memoryLimitMiB: 4096,
      cpu: 2048,
    });

    taskDefinition.addContainer("SearchAPI", {
      image: ecs.ContainerImage.fromAsset("./api"),
      portMappings: [{ containerPort: 3000 }],
      environment: {
        OPENSEARCH_URL: opensearchDomain.domainEndpoint,
      },
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: "search-api" }),
    });

    new ecs.FargateService(this, "SearchService", {
      cluster,
      taskDefinition,
      desiredCount: 2,
      assignPublicIp: false,
    });
  }
}
