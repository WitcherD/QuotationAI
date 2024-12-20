import { HumanMessage } from "@langchain/core/messages";
import { ChatVertexAI } from "@langchain/google-vertexai";
import { START, END, StateGraph, MemorySaver, Annotation, Send } from "@langchain/langgraph";
import { ChatOpenAI } from "@langchain/openai";
import { QdrantService } from "./qdrant.js";
import dotenv from 'dotenv';

console.log("Loading environment variables from .env file...");
dotenv.config();

const memory = new MemorySaver();

const openAI = new ChatOpenAI({
    model: "gpt-4o-mini",
    apiKey: process.env.OPENAI_API_KEY
});

const vertexAI = new ChatVertexAI({
    modelName: "gemini-1.5-flash-002",
});

const QuotationAnnotation = Annotation.Root({
    userInput: Annotation<string>({
        value: (_prev, newValue) => newValue,
        default: () => "",
    }),
    knowledgeBase: Annotation<string>({
        value: (_prev, newValue) => newValue,
        default: () => "",
    }),
    pricingTables: Annotation<Record<string, string>>({
        value: (_prev, newValue) => ({ ..._prev, ...newValue }),
        default: () => ({}),
    }),
    finalQuotation: Annotation<string>({
        value: (_prev, newValue) => newValue,
        default: () => "",
    }),
    status: Annotation<string>({
        value: (_prev, newValue) => newValue,
        default: () => "pending",
    }),
});

const PricingAnnotation = Annotation.Root({
    services: Annotation<string[]>({
        value: (_prev, newValue) => [...new Set([..._prev, ...newValue])],
        default: () => [],
    }),
    prices: Annotation<Record<string, string>>({
        reducer: (_prev, newValue) => ({ ..._prev, ...newValue }),
        default: () => ({}),
    }),
});

async function generateServices(state: typeof PricingAnnotation.State): Promise<Partial<typeof PricingAnnotation.State>> {
    const input = [
        new HumanMessage({
            content: [
                {
                    type: "text",
                    text: "Generate a list up to 2 cleaning service names, separated by commas, non-numeric",
                },
                {
                    type: "image_url",
                    image_url: `https://cdn-icons-png.flaticon.com/512/3770/3770771.png`,
                }
            ],
        }),
    ];

    const response = await vertexAI.invoke(input);
    return { services: (response.content as string).split(", ") };
}

async function generatePricingTable(input: { serviceName: string }): Promise<Partial<typeof PricingAnnotation.State>> {
    const response = await openAI.invoke(`Generate a short demo pricing table for service ${input.serviceName}`);
    return { prices: { [input.serviceName]: response.content as string } }; // Fixed to use actual serviceName as key
}

function routeToPricingTableGeneration(state: typeof PricingAnnotation.State) {
    return state.services.map((service) => new Send("generatePricingTable", { serviceName: service }));
}

const pricingSubgraphBuilder = new StateGraph(PricingAnnotation)
    .addNode("generateServices", generateServices)
    .addNode("generatePricingTable", generatePricingTable)
    .addConditionalEdges("generateServices", routeToPricingTableGeneration)
    .addEdge(START, "generateServices")
    .addEdge("generatePricingTable", END);

const pricingSubgraph = pricingSubgraphBuilder.compile({ checkpointer: memory });

async function getUserInput(state: typeof QuotationAnnotation.State): Promise<Partial<typeof QuotationAnnotation.State>> {
    
    const userInput = 'move-out cleaning';
    const qdrantService = QdrantService.getInstance();
    
    const results = await qdrantService.similaritySearch(userInput, 2, process.env.QDRANT_COLLECTION!, {
        "metadata": { "date_time_scheduling_rule": { "$exists": false } }
    });
    const knowledgeBase = results.map(doc => doc.pageContent).join("\n");

    return {
        userInput,
        knowledgeBase,
        status: "received"
    };
}

async function getPricingTables(state: typeof QuotationAnnotation.State): Promise<Partial<typeof QuotationAnnotation.State>> {
    const pricingResult = await pricingSubgraph.invoke({});

    return {
        pricingTables: pricingResult.prices,
        status: "pricing_complete"
    };
}

async function generateQuotation(state: typeof QuotationAnnotation.State): Promise<Partial<typeof QuotationAnnotation.State>> {
    const details = Object.entries(state.pricingTables)
        .map(([service, pricingTable]) => `${service}: ${pricingTable}`)
        .join("\n");

    return {
        finalQuotation: `Quotation Details:\n${details}`,
        status: "completed"
    };
}

const mainGraph = new StateGraph(QuotationAnnotation)
    .addNode("getUserInput", getUserInput)
    .addNode("getPricingTables", getPricingTables)
    .addNode("generateQuotation", generateQuotation)
    .addEdge(START, "getUserInput")
    .addEdge("getUserInput", "getPricingTables")
    .addEdge("getPricingTables", "generateQuotation")
    .addEdge("generateQuotation", END)
    .compile({ checkpointer: memory });

export function createGraph() {
    return mainGraph;
}
