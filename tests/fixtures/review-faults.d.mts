// What tests read of the review faults both replay fakes send (review-faults.mjs; M22e, C42).
export declare const REVIEW_OPENING: string;
export declare const SEND_NOTES_OPENING: string;
export declare const INTEGRATION_OPENING: string;
export declare function isReviewPrompt(text: unknown): boolean;
export declare function isSendNotes(text: unknown): boolean;
export declare function isIntegration(text: unknown): boolean;
/** A review capture's text with each file marker made neutral, as the fakes replay it. */
export declare function unmarked(text: string): string;
export declare const FIRST_ANSWER_FAULTS: readonly string[];
export declare const LATER_ANSWER_FAULTS: readonly string[];
/** A captured answer, one named change made to it. */
export declare function faulted(name: string, text: string): string;
