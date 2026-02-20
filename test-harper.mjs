import { LocalLinter, BinaryModule } from '/tmp/spelling-tab-link/node_modules/harper.js/dist/harper.js';
import { pathToFileURL } from 'url';

// Use symlink path to avoid spaces (Harper.js bug with spaces in file:// URLs)
const wasmPath = '/tmp/spelling-tab-link/node_modules/harper.js/dist/harper_wasm_bg.wasm';
const wasmUrl = pathToFileURL(wasmPath).href;
console.log('WASM URL:', wasmUrl);

const binary = BinaryModule.create(wasmUrl);
const linter = new LocalLinter({ binary });
await linter.setup();

console.log('Linter ready!\n');

const text = "This is a bad apple, eat apple a day keep eye here don't do this here for next few day or it will be bad as you know it.";

console.log('Testing:', JSON.stringify(text));
console.log('---');

const lints = await linter.lint(text, { language: 'plaintext' });
console.log(`Found ${lints.length} issues:\n`);

lints.forEach((lint, i) => {
  const span = lint.span();
  const suggestions = lint.suggestions();
  const problemText = lint.get_problem_text();
  const message = lint.message();
  const kind = lint.lint_kind();
  const kindPretty = lint.lint_kind_pretty();

  console.log(`${i+1}. [${kind} / ${kindPretty}]`);
  console.log(`   Problem: "${problemText}" (chars ${span.start}-${span.end})`);
  console.log(`   Message: ${message}`);
  console.log(`   Suggestions: ${suggestions.map(s => `"${s.get_replacement_text()}"`).join(', ') || 'none'}`);
  console.log('');

  span.free();
  suggestions.forEach(s => s.free());
  lint.free();
});

// Also test some known grammar issues
const tests = [
  "eat apple a day",
  "keep eye here",
  "for next few day",
  "an apple a day keeps the doctor away",
  "eat a apple",
  "i dont like this",
  "she dont know",
  "their going home",
  "your welcome",
  "its a nice day",
  "he could of done it",
  "I should of known",
  "alot of people",
  "definately wrong",
  "I recieved the package",
  "the the quick brown fox",
  "He do not like it",
  "She have a car",
  "Me and him went there",
  "I has been there",
];

console.log('\n=== Individual phrase tests ===\n');

for (const t of tests) {
  const l = await linter.lint(t, { language: 'plaintext' });
  if (l.length > 0) {
    console.log(`"${t}" → ${l.length} issue(s):`);
    l.forEach(lint => {
      const suggs = lint.suggestions();
      console.log(`  [${lint.lint_kind()}] "${lint.get_problem_text()}" → ${suggs.map(s => `"${s.get_replacement_text()}"`).join(', ')}`);
      suggs.forEach(s => s.free());
      lint.free();
    });
  } else {
    console.log(`"${t}" → NO issues detected`);
  }
}

// Check lint descriptions to see all available rules
console.log('\n=== Available Lint Rules ===\n');
const descriptions = await linter.getLintDescriptionsAsJSON();
const descs = JSON.parse(descriptions);
console.log(`Total rules: ${Object.keys(descs).length}`);
Object.entries(descs).forEach(([name, desc]) => {
  console.log(`  ${name}: ${desc}`);
});

linter.dispose();
