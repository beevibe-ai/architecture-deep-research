import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import {
  findPrinciple,
  renderViolationForTerminal
} from "./comment-renderer.mjs";

// Walk the user through each violation one at a time. They can:
//   ENTER  → accept (keep for posting)
//   s      → skip (drop)
//   e      → edit the message inline before accepting
//   q      → quit early, accept nothing further
// Returns the accepted violations in order.
async function runInteractiveWalkthrough(violations, principles) {
  if (violations.length === 0) return [];

  const rl = readline.createInterface({ input, output });
  const accepted = [];
  let quit = false;

  console.log("");
  console.log(
    `\x1b[1m${violations.length} potential violations.\x1b[0m  ` +
      `\x1b[2mENTER=accept · s=skip · e=edit · q=stop\x1b[0m`
  );
  console.log("");

  for (let i = 0; i < violations.length; i += 1) {
    if (quit) break;
    const v = violations[i];
    const p = findPrinciple(principles, v.principle_id);
    if (!p) continue;

    console.log(renderViolationForTerminal(v, p, i, violations.length));
    const answer = (await rl.question("  > ")).trim().toLowerCase();

    if (answer === "q") {
      quit = true;
      console.log("");
      continue;
    }
    if (answer === "s") {
      console.log("");
      continue;
    }
    if (answer === "e") {
      const newMessage = (
        await rl.question("  new message: ")
      ).trim();
      accepted.push({
        ...v,
        message: newMessage.length > 0 ? newMessage : v.message
      });
      console.log("");
      continue;
    }
    // ENTER or anything else → accept as-is
    accepted.push(v);
    console.log("");
  }

  rl.close();
  return accepted;
}

export { runInteractiveWalkthrough };
