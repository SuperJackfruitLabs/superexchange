/**
 * What the contract-checked fakes (`contracts.ts`) found wrong with a request this service sent.
 * No imports: the preload drains it after every test and fails the test that left one, because a
 * client swallows a fetch that throws (a refusal reads as "unreachable"), so a throw would hide
 * the very request that broke the contract.
 */
export const contractViolations: string[] = [];
