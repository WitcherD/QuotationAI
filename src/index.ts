import { createGraph } from "./graph.js";
import { QdrantService } from "./qdrant.js";
import { CallbackHandler } from "langfuse-langchain";
import { LunaryHandler } from "lunary/langchain";

const langfuseHandler = new CallbackHandler({
  publicKey: process.env.PUBLIC_KEY,
  secretKey: process.env.SECRET_KEY,
  baseUrl: "https://cloud.langfuse.com"
});

const lunaryHandler = new LunaryHandler({
});

async function ingestDocuments(): Promise<void> {
  try {
    const qdrantService = QdrantService.getInstance();
    const hasExistingDocs = await qdrantService.hasDocuments(process.env.QDRANT_COLLECTION!);

    if (!hasExistingDocs) {
      console.log("No existing documents found. Creating collection and adding documents...");
      await qdrantService.createCollection(process.env.QDRANT_COLLECTION!);

      const documents = [
        { pageContent: "Our residential cleaning services include dusting, vacuuming, and sanitizing of all surfaces, including kitchens and bathrooms.", metadata: { source: "Alice Smith" } },
        { pageContent: "Our office cleaning services include daily, weekly, or monthly cleaning of your office space, including trash removal and restocking of supplies.", metadata: { source: "Tech Corp" } },
        { pageContent: "Our move-out cleaning services include a thorough cleaning of your old home, including the kitchen, bathrooms, and floors.", metadata: { source: "John Doe" } },
        { pageContent: "Our post-construction cleaning services include removal of debris, dust, and dirt from all surfaces, including floors, walls, and windows.", metadata: { source: "XYZ Builders" } },
        { pageContent: "Our carpet cleaning services include deep cleaning of your carpets using eco-friendly products and state-of-the-art equipment.", metadata: { source: "Mary Johnson" } },
      ];

      await qdrantService.addDocuments(documents, process.env.QDRANT_COLLECTION!);
      console.log("Documents added successfully.");
    } else {
      console.log("Documents already exist in collection. Skipping ingestion.");
    }
  } catch (error) {
    console.error("Error ingesting documents:", error);
  }
}

async function invokeGraph() {
  try {
    const graph = createGraph();

    const threadId = "thread_" + Date.now();
    const result = await graph.invoke({}, {
      callbacks: [langfuseHandler, lunaryHandler],
      configurable: { thread_id: threadId },
      metadata: { langfuseSessionId: threadId, thread_id: threadId, user_id: "user_" + Date.now(), tenant_name: "Demo Project" }
    });

    console.log("User Input:", result.userInput);
    console.log("Status:", result.status);
    console.log("\n" + result.finalQuotation);
  } catch (error) {
    console.error("Error invoking graph:", error);
  }
}

async function main() {
  try {
    await ingestDocuments();
    await invokeGraph();
  } catch (error) {
    console.error("Error in main function:", error);
  }
}

main();
