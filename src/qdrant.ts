import { QdrantVectorStore } from "@langchain/qdrant";
import { QdrantClient } from "@qdrant/js-client-rest";
import { OpenAIEmbeddings } from "@langchain/openai";
import { Document } from "@langchain/core/documents";
import { traceable } from "langsmith/traceable";

export class QdrantService {
    private static instance: QdrantService;
    public client: QdrantClient;
    private embeddings: OpenAIEmbeddings;
    
    private url = process.env.QDRANT_URL;
    private apiKey = process.env.QDRANT_API_KEY;
    private openaiApiKey = process.env.OPENAI_API_KEY;

    private constructor() {
        this.client = new QdrantClient({
            url: this.url,
            apiKey: this.apiKey,
        });

        this.embeddings = new OpenAIEmbeddings({
            model: "text-embedding-3-small",
            apiKey: this.openaiApiKey
        });
    }

    public static getInstance(): QdrantService {
        if (!QdrantService.instance) {
            QdrantService.instance = new QdrantService();
        }
        return QdrantService.instance;
    }

    public async createCollection(collectionName: string): Promise<void> {
        try {
            await this.client.createCollection(collectionName, {
                vectors: {
                    size: 1536,
                    distance: "Cosine"
                }
            });
            console.log("Created new collection:", collectionName);
        } catch (e) {
            console.log("Collection might already exist, continuing...");
        }
    }

    public async getVectorStore(collectionName: string): Promise<QdrantVectorStore> {
        return new QdrantVectorStore(this.embeddings, {
            client: this.client,
            collectionName,
        });
    }

    public async addDocuments(documents: Document[], collectionName: string): Promise<void> {
        const vectorStore = await this.getVectorStore(collectionName);
        await vectorStore.addDocuments(documents);
        console.log("Successfully added documents to Qdrant");
    }

    public async similaritySearch(query: string, k: number, collectionName: string, filter?: object): Promise<Document[]> {
        const vectorStore = await this.getVectorStore(collectionName);
        const retrieveDocs = traceable((query: string, filter?: object) => vectorStore.similaritySearch(query, k, filter), { name: "retrieveDocs", run_type: "retriever" });
        return await retrieveDocs(query, filter);
    }

    public async hasDocuments(collectionName: string): Promise<boolean> {
        try {
            const collectionInfo = await this.client.getCollection(collectionName);
            return (collectionInfo.points_count || 0) > 0;
        } catch (e) {
            return false;
        }
    }
}
