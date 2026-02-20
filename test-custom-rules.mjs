import { runCustomRules } from '/tmp/spelling-tab-link/src/background/custom-rules.js';

console.log('=== NEW RULES TEST ===\n');

const tests = [
  // Lay/Lie
  ["I'm going to lay down", "lie down"],
  ["I laid down yesterday", "lay down"],
  ["the sun raises in the east", "rises"],

  // Reflexive pronoun
  ["contact John or myself", "me"],
  ["myself and Tom will present", "I"],

  // Between you and I
  ["between you and I", "you and me"],
  ["for you and I", "you and me"],
  ["with him and I", "him and me"],

  // Good/Well, Bad/Badly
  ["he did good on the test", "did well"],
  ["I feel badly about it", "feel bad"],
  ["the food tastes well", "tastes good"],

  // Everyday vs Every day
  ["I go there everyday", "every day"],
  ["an every day occurrence", "everyday"],

  // Double negatives
  ["I don't need no help", "any"],
  ["don't nobody tell me", "anybody"],
  ["can't get nothing done", "anything"],

  // Amount vs Number
  ["the amount of students", "number"],
  ["amount of people", "number"],

  // Borrow vs Lend
  ["can you borrow me a pen", "lend"],

  // Redundant expressions
  ["the end result was good", "result"],
  ["a free gift for you", "gift"],
  ["past history shows", "history"],
  ["unexpected surprise", "surprise"],
  ["revert back to the old version", "revert"],
  ["exact same thing", "same"],

  // Very unique
  ["this is very unique", "unique"],
  ["completely unique design", "unique"],

  // Try and → Try to
  ["try and fix it", "try to"],

  // Who vs That
  ["the person that is here", "who"],
  ["people that are coming", "who"],

  // Different than → Different from
  ["this is different than that", "different from"],

  // Plural after numbers
  ["5 apple", "apples"],
  ["three dog", "dogs"],
  ["several item", "items"],
  ["many student", "students"],
];

let passed = 0;
let failed = 0;

for (const [input, expectedWord] of tests) {
  const l = runCustomRules(input, []);
  if (l.length > 0) {
    const allSuggestions = l.flatMap(lint => lint.suggestions.map(s => s.text)).join(' | ');
    const found = allSuggestions.toLowerCase().includes(expectedWord.toLowerCase()) ||
                  l.some(lint => lint.message.toLowerCase().includes(expectedWord.toLowerCase()));
    if (found) {
      passed++;
      console.log(`✅ "${input}" → [${l[0].lintKindPretty}] ${l[0].suggestions.map(s => `"${s.text}"`).join(', ')}`);
    } else {
      failed++;
      console.log(`⚠️  "${input}" → flagged but wrong suggestion: ${allSuggestions}`);
    }
  } else {
    failed++;
    console.log(`❌ "${input}" → MISSED (expected: ${expectedWord})`);
  }
}

console.log(`\n${passed} passed, ${failed} failed out of ${tests.length} tests.`);

// False positive checks
console.log('\n=== FALSE POSITIVE CHECKS ===\n');
const clean = [
  "I need to lie down.",
  "She laid the book on the table.",
  "Between you and me, this is bad.",
  "He did well on the test.",
  "I feel bad about it.",
  "This is an everyday occurrence.",
  "I exercise every day.",
  "I don't need any help.",
  "The number of students is growing.",
  "This is unique.",
  "Try to fix it.",
  "The person who is here.",
  "This is different from that.",
  "5 apples on the table.",
  "Three dogs in the park.",
  "Contact John or me.",
  "He can lend me a pen.",
];

let fpCount = 0;
for (const t of clean) {
  const l = runCustomRules(t, []);
  if (l.length > 0) {
    fpCount++;
    console.log(`❌ FALSE POSITIVE: "${t}" → ${l.map(lint => `[${lint.lintKindPretty}] "${lint.problemText}"`).join(', ')}`);
  } else {
    console.log(`✅ "${t}"`);
  }
}
console.log(`\n${fpCount} false positives out of ${clean.length} clean sentences.`);
