export type Difficulty = 'easy' | 'exam' | 'hard';

export type Language = 'en' | 'uz' | 'ru';

export type QuestionType = 'poll' | 'open' | 'tfng';

export interface PollQuizQuestion {
  question: string;
  options: string[];
  correctIndex: number;
  explanation: string;
}

export interface OpenQuizQuestion {
  question: string;
  answer: string;
  acceptableAnswers?: string[];
  explanation: string;
}

export type QuizQuestion = PollQuizQuestion | OpenQuizQuestion;

export interface QuizResponse {
  questions: QuizQuestion[];
}

export interface UserSession {
  fileText?: string;
  fileLanguage?: Language;
  fileWindowIndex?: number;
  fileWindowCount?: number;
  awaitingPartSelection?: boolean;
  questionType?: QuestionType;
  questionCount?: number;
  difficulty?: Difficulty;
  isProcessing?: boolean;
  processingStartedAt?: number;
  lastSeenAt?: number;

  isPro?: boolean;
  proUntil?: number;
  proWarned3d?: boolean;
  proWarned1d?: boolean;
  proExpiredNotified?: boolean;
  dailyUsageDayKey?: string;
  dailyQuestionsUsed?: number;
  lastLowQuotaWarnedRemaining?: number;

  language?: Language;

  onboardingAsked?: boolean;
  contactShared?: boolean;
  phoneNumber?: string;
  lastContactPromptAt?: number;

  askedQuestionTexts?: string[];
  generationRound?: number;

  adminAwaitingBroadcast?: boolean;
  adminAwaitingReset?: boolean;
  adminAwaitingUserInfo?: boolean;
  adminAwaitingProGrant?: boolean;

  quizQuestions?: QuizQuestion[];
  currentQuestionIndex?: number;
  awaitingOpenAnswer?: boolean;
  score?: number;
  totalQuestions?: number;

  tokenUsage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
    byProvider?: Record<string, { promptTokens?: number; completionTokens?: number; totalTokens?: number }>;
    byModel?: Record<string, { promptTokens?: number; completionTokens?: number; totalTokens?: number }>;
  };
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
