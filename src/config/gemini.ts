import { GoogleGenAI } from "@google/genai";

// Initialize the Gemini AI client
// Using the recommended pattern from guidelines
export const ai = new GoogleGenAI({ apiKey: process.env.API_KEY || process.env.GEMINI_API_KEY });

// Define models based on task requirements
// Updated to gemini-3-flash-preview as per coding guidelines for basic text tasks
export const QUIZ_MODEL = 'gemini-3-flash-preview';