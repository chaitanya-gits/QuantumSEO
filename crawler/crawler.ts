import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import { chromium } from "playwright";

const sqs = new SQSClient({ region: process.env.AWS_REGION ?? "us-east-1" });

export interface CrawledPage {
  url: string;
  title: string;
  body: string;
  outboundLinks: string[];
  crawledAt: string;
}

export async function crawlPage(url: string): Promise<CrawledPage> {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15_000 });

    const title = await page.title();
    const body = await page.evaluate(() => {
      const removeSelectors = ["nav", "footer", "script", "style", "header", "aside"];
      removeSelectors.forEach((selector) => {
        document.querySelectorAll(selector).forEach((element) => element.remove());
      });

      return document.body.innerText.replace(/\s+/g, " ").trim();
    });

    const outboundLinks = await page.evaluate(() =>
      Array.from(document.querySelectorAll("a[href]"))
        .map((anchor) => (anchor as HTMLAnchorElement).href)
        .filter((href) => href.startsWith("http"))
        .slice(0, 100),
    );

    const doc: CrawledPage = {
      url,
      title,
      body,
      outboundLinks,
      crawledAt: new Date().toISOString(),
    };

    const queueUrl = process.env.CRAWL_QUEUE_URL;
    if (!queueUrl) {
      throw new Error("CRAWL_QUEUE_URL is required to enqueue crawled pages.");
    }

    await sqs.send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: JSON.stringify(doc),
      }),
    );

    return doc;
  } finally {
    await browser.close();
  }
}
