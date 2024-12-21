import { START, END, StateGraph, MemorySaver, Annotation } from "@langchain/langgraph";
import { ChatOpenAI } from "@langchain/openai";
import { QdrantService } from "./qdrant.js";
import { traceable } from "langsmith/traceable";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import piston from "piston-client";
import dotenv from 'dotenv';

dotenv.config();
const memory = new MemorySaver();

const openAI = new ChatOpenAI({
    model: "gpt-4o-mini",
    temperature: 0,
    apiKey: process.env.OPENAI_API_KEY
});

const codeInterpreter = piston({});

const SchedulingAnnotation = Annotation.Root({
    customerInquiry: Annotation<string>({
        value: (_prev, newValue) => newValue,
        default: () => "",
    }),
    schedulingRules: Annotation<string[]>({
        value: (_prev, newValue) => newValue,
        default: () => [],
    }),
    pythonValidationMethod: Annotation<string>({
        value: (_prev, newValue) => newValue,
        default: () => "",
    }),
    pythonParametersExtractionMethod: Annotation<string>({
        value: (_prev, newValue) => newValue,
        default: () => "",
    }),
    validationErrors: Annotation<string[]>({
        value: (_prev, newValue) => newValue,
        default: () => [],
    }),
    validationPassed: Annotation<boolean>({
        value: (_prev, newValue) => newValue,
        default: () => false,
    }),
    status: Annotation<string>({
        value: (_prev, newValue) => newValue,
        default: () => "pending",
    }),
});

async function extractRulesFromQdrant(): Promise<Partial<typeof SchedulingAnnotation.State>> {
    console.log("rulesExtractorFromQdrant: start");
    try {
        const qdrantService = QdrantService.getInstance();
        const schedulingRuleDocuments = await qdrantService.client.scroll(process.env.QDRANT_COLLECTION!, {
            filter: {
                must: [
                    {
                        key: "metadata.date_time_scheduling_rule",
                        match: { value: true }
                    }]
            }
        });

        const extractedRules = schedulingRuleDocuments.points.map(doc => doc.payload?.content as string)
        console.log("rulesExtractorFromQdrant: end", extractedRules);
        return { schedulingRules: extractedRules };
    } catch (error) {
        console.error("rulesExtractorFromQdrant: error", error);
        throw error;
    }
}

async function generatePythonValidationCode(state: typeof SchedulingAnnotation.State): Promise<Partial<typeof SchedulingAnnotation.State>> {
    console.log("pythonValidationCodeGeneration: start");
    try {
        const systemPrompt =
            `Your task is to transform company rules into a Python validation method.

## Instructions:
- You are only allowed to use the "datetime" and "calendar" packages.
- You can add private helper methods to simplify and organize the validation logic.
- Return only the method definition without any import statements or additional code.
- All input parameters will be provided in GMT+8 timezone.
- All parameters are optional (can be None). Perform rule validation only if the relevant parameter is provided.
- Always check each parameter for None before applying validation logic.
- The method should return a list of strings representing validation errors. If no errors are found, return an empty list.
- Frequency can take one of the following values: "Adhoc", "Daily", "Weekly", "Monthly".
- Do not include any logging or print statements.

## Method Details:
Method name: \`validateCustomerSchedulingParameters\`
Method arguments:
    - year: int or None
    - month: int or None
    - day: int or None
    - hour: int or None
    - minute: int or None
    - duration_hours: float or None
    - frequency: str or None
Method output: list[str]

## Example:

## Input: 
{ "validationRules": [ "Can't book an appointment less than 48 hours in advance for new clients.", "Appointments can only be booked up to 3 months in advance."] }

### Output:
def validateCustomerSchedulingParameters(year=None, month=None, day=None, hour=None, minute=None, duration_hours=None, frequency=None):
    errors = []
    
    if year is not None and month is not None and day is not None and hour is not None and minute is not None:
        from datetime import datetime, timedelta

        scheduling_time = datetime(year, month, day, hour, minute)
        current_time = datetime.utcnow() + timedelta(hours=8)  # Adjusting to GMT+8
        
        # Rule 1: Can't book an appointment less than 48 hours in advance for new clients.
        if scheduling_time < current_time + timedelta(hours=48):
            errors.append("Can't book an appointment less than 48 hours in advance for new clients.")
        
        # Rule 2: Appointments can only be booked up to 3 months in advance.
        max_scheduling_time = current_time + timedelta(days=90)
        if scheduling_time > max_scheduling_time:
            errors.append("Appointments can only be booked up to 3 months in advance.")
    
    return errors

## Notes
Ensure the output is plain Python code without any formatting or additional explanations.`;

        const messages = [
            new SystemMessage(systemPrompt),
            new HumanMessage(JSON.stringify({ validationRules: state.schedulingRules })),
        ];
        const response = await openAI.invoke(messages);
        console.log("pythonValidationCodeGeneration: end", { pythonValidationMethod: response.content });
        return { pythonValidationMethod: response.content as string };
    } catch (error) {
        console.error("pythonValidationCodeGeneration: error", error);
        throw error;
    }
}

async function tranformUserInputIntoPython(state: typeof SchedulingAnnotation.State): Promise<Partial<typeof SchedulingAnnotation.State>> {
    console.log("tranformUserInputIntoPython: start");
    try {
        const systemPrompt = `Your task is to transform natural language text into Python code that extracts datetime-related scheduling parameters from user input.  

## Instructions:  
- You are allowed to use only the "datetime" and "calendar" libraries.  
- You can define additional private helper methods to improve code readability and modularize validation logic.  
- Do not include any import statements in the output.  
- Assume all input timestamps are provided in the GMT+8 timezone. Adjust calculations accordingly.  
- The output should be a single method definition with the following characteristics:  
  - Method name: \`getCustomerSchedulingParameters\`  
  - Arguments: None  
  - Return: A JSON object with the keys:  
    - \`appointment_date\`: The day of the month (integer or \`None\`).  
    - \`appointment_month\`: The month of the year (integer or \`None\`).  
    - \`appointment_year\`: The year (integer or \`None\`).  
    - \`appointment_time_hour\`: The hour of the day in 24-hour format (integer or \`None\`).  
    - \`appointment_time_minute\`: The minute of the hour (integer or \`None\`).  
    - \`duration_hours\`: The duration of the appointment in hours (float or \`None\`).  
    - \`frequency\`: The recurrence of the appointment. Can be \`"Adhoc"\`, \`"Daily"\`, \`"Weekly"\`, or \`"Monthly"\` (string or \`None\`).  

- If a specific value is not found in the text, return \`None\` for that field.  
- Focus only on extracting values explicitly mentioned in the input text; do not make assumptions.  
- Do not include print statements or logging in the output.  

## Example:  

### Input:  
"I want to book an appointment for next Monday at 2pm for 2.5 hours."  

### Output:  
def getCustomerSchedulingParameters():  
    """Extracts and returns scheduling parameters from user input in GMT+8 timezone.  
    
    Returns:  
        A JSON object with the required scheduling parameters.  
    """  
    def _get_next_monday():  
        """Helper function to calculate the date of the next Monday."""  
        current_time = datetime.utcnow() + timedelta(hours=8)  # Adjust to GMT+8  
        today = current_time.date()  
        days_until_monday = (7 - today.weekday() + 0) % 7  # Monday is 0  
        return today + timedelta(days=days_until_monday)  
    
    next_monday = _get_next_monday()  
    return {  
        "appointment_date": next_monday.day,  
        "appointment_month": next_monday.month,  
        "appointment_year": next_monday.year,  
        "appointment_time_hour": 14,  
        "appointment_time_minute": 0,  
        "duration_hours": 2.5,  
        "frequency": "Adhoc"  
    }

### Notes:
Ensure the output is plain Python code without any formatting or additional explanations.`;
        const messages = [
            new SystemMessage(systemPrompt),
            new HumanMessage(state.customerInquiry),
        ];
        const response = await openAI.invoke(messages);
        console.log("tranformUserInputIntoPython: end");
        return { pythonParametersExtractionMethod: response.content as string };
    } catch (error) {
        console.error("tranformUserInputIntoPython: error", error);
        throw error;
    }
}

async function validateSchedulingRequest(state: typeof SchedulingAnnotation.State): Promise<Partial<typeof SchedulingAnnotation.State>> {
    console.log("validateSchedulingRequest: start");
    const pythonCodeToInvoke = `
import sys
import datetime
import calendar
import json

${state.pythonValidationMethod}

${state.pythonParametersExtractionMethod}

parameters = getCustomerSchedulingParameters()

valiation_errors = validateCustomerSchedulingParameters(parameters["appointment_year"], parameters["appointment_month"], parameters["appointment_date"], parameters["appointment_time_hour"], parameters["appointment_time_minute"], parameters["duration_hours"], parameters["frequency"])

print(json.dumps({"validation_errors": valiation_errors}))`;

    const traceableCodeInterpreterFunction = await traceable((pythonCodeToInvoke: string) => codeInterpreter.execute('python', pythonCodeToInvoke, { args: [] }));
    const result = await traceableCodeInterpreterFunction(pythonCodeToInvoke);
    console.log("codeInterpreter response", result);

    const validationErrors = result.run?.stdout?.length > 0 
        ? JSON.parse(result.run.stdout)?.validation_errors 
        : undefined;

    if (validationErrors === undefined) 
        throw new Error("Failed to validate scheduling request.");

    if (validationErrors.length > 0) {
        return { validationErrors, validationPassed: false };
    } else {
        return { validationPassed: true };
    }
}

async function responseNode(state: typeof SchedulingAnnotation.State): Promise<Partial<typeof SchedulingAnnotation.State>> {
    console.log("responseNode: start");
    if (state.validationPassed) {
        console.log("responseNode: end", { status: "validation_passed" });
        return { status: "validation_passed" };
    } else {
        console.log("responseNode: end", { status: "validation_failed" });
        return { status: "validation_failed" };
    }
}

const companyRulesExtractionSubgraph = new StateGraph(SchedulingAnnotation)
    .addNode("extractRulesFromQdrant", extractRulesFromQdrant)
    .addNode("generatePythonValidationCode", generatePythonValidationCode)
    .addEdge(START, "extractRulesFromQdrant")
    .addEdge("extractRulesFromQdrant", "generatePythonValidationCode")
    .addEdge("generatePythonValidationCode", END)
    .compile({ });

const schedulingGraph = new StateGraph(SchedulingAnnotation)
    .addNode("tranformCompanyRulesIntoPython", companyRulesExtractionSubgraph)
    .addNode("tranformUserInputIntoPython", tranformUserInputIntoPython)
    .addNode("validateSchedulingRequest", validateSchedulingRequest)
    .addNode("sendUserReply", responseNode)
    .addEdge(START, "tranformCompanyRulesIntoPython")
    .addEdge(START, "tranformUserInputIntoPython")
    .addEdge("tranformUserInputIntoPython", "validateSchedulingRequest")
    .addEdge("tranformCompanyRulesIntoPython", "validateSchedulingRequest")
    .addEdge("validateSchedulingRequest", "sendUserReply")
    .addEdge("sendUserReply", END)
    .compile({ });

export function createSchedulingGraph() {
    return schedulingGraph;
}
