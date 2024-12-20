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

function init(): Partial<typeof SchedulingAnnotation.State> {
    console.log("init: start");
    return {};
}

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
            `Your task is to transform company rules into Python validation method.

## Instructions:
- You are allowed to use the "datetime" and "calendar" packages only.
- You are allowed to add additional private methods to make the validation logic more readable.
- Return only the method definition without any import statements. 
- All input parameters will be provided in GMT+8 timezone. 
- All parameters are optional (can be None), meaning you should only perform rule validation only if a value is provided.
- Always check parameters for None. Each rule should have have conditions checking for None.
- The method should return a list of strings representing validation errors. If there are no errors, return an empty list.
- Frequency can be "Adhoc", "Daily", "Weekly", "Monthly".
- No output logs.

## Method description:
Method name: "validateCustomerSchedulingParameters"
Method arguments:
    year: int or None
    month: int or None
    day: int or None
    hour: int or None
    minute: int or None
    duration_hours: float or None
    frequency: str or None
Method output: list[str]

Example:
<example_input>
{ "validationRules": [ "Can't book an appointment less than 48 hours in advance for new clients.", "Appointments can only be booked up to 3 months in advance."] }
</example_input>
<example_output>
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
</output>

Don't format output. Return plain text python code.`;
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
        const systemPrompt = `Your task is to transform text into python code which returns datetime parameters from user input.
## Instructions:
- You are allowed to use the "datetime" and "calendar" packages only. 
- You are allowed to add additional private methods to make the validation logic more readable.
- Return only the method definition without any import statements. 
- All input parameters will be provided in GMT+8 timezone. 
- The method should return a json object with the following keys: "appointment_date", "appointment_month", "appointment_year", "appointment_time_hour", "appointment_time_minute", "duration_hours", "frequency".
- All keys are required. You should only extract values if they are present in the text, otherwise set them to None.
- Frequency can be "Adhoc", "Daily", "Weekly", "Monthly".
- No output logs.

## Method description:
Method name: "getCustomerSchedulingParameters"
Method arguments: No arguments
Method output: json object

Example:
<example_input>
I want to book an appointment for next monday at 2pm for 2.5 hours
</example_input>
<example_output>
def get_next_monday():
    """Returns the date of the next Monday."""
    from datetime import datetime
    current_time = datetime.utcnow() + timedelta(hours=8)  # Adjusting to GMT+8
    today = current_time.date()
    today_weekday = today.weekday()  # Monday is 0, Sunday is 6
    days_until_monday = (7 - today_weekday + 0) % 7 #0 is for monday. using modulo operator for correct calculation
    next_monday = today + datetime.timedelta(days=days_until_monday)
    return next_monday

def getCustomerSchedulingParameters():
    """
    Returns scheduling parameters in GMT+8 timezone.

    Returns a dictionary with the following keys (all required):
        appointment_date: Day of the month (int or None)
        appointment_month: Month of the year (int or None)
        appointment_year: Year (int or None)
        appointment_time_hour: Hour of the day (int or None) - 24-hour format
        appointment_time_minute: Minute of the hour (int or None)
        duration_hours: Duration of the appointment (float or None)
        frequency: Frequency of the appointment (string or None) - "Adhoc", "Daily", "Weekly", "Monthly"
    """
    next_monday = get_next_monday()
    return {
        "appointment_date": next_monday.day,
        "appointment_month": next_monday.month,
        "appointment_year": next_monday.year,
        "appointment_time_hour": 14,
        "appointment_time_minute": 0,
        "duration_hours": 2.5,
        "frequency": "Adhoc"
    }
</example_output>

Don't format output. Return plain text python code.`;
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
