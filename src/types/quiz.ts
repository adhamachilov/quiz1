export type Difficulty = 'easy' | 'exam' | 'hard';

export type Language = 'en' | 'uz' | 'ru';

export interface QuizQuestion {
  question: string;
  options: string[];
  correctIndex: number;
  explanation: string;
}

export interface QuizResponse {
  questions: QuizQuestion[];
}

export interface UserSession {
  fileText?: string;
  fileLanguage?: Language;
  questionCount?: number;
  difficulty?: Difficulty;
  isProcessing?: boolean;

  language?: Language;

  adminAwaitingBroadcast?: boolean;

  quizQuestions?: QuizQuestion[];
  currentQuestionIndex?: number;
  score?: number;
  totalQuestions?: number;
}

// Map structure for storing poll metadata to handle answers
export interface PollMetadata {
  chatId: number;
  userId: number;
  questionIndex: number;
  correctIndex: number;
  explanation: string;
  question: string;
}
