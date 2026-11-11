const OPERATORS = { plus: "+", minus: "-", times: "*", multiplied: "*", divided: "/" };
const NUMBER = /^(?:\d+(?:\.\d+)?|\.\d+)$/;
const MAX_MAGNITUDE = 1e15;

function calculate(text) {
  const expression = text.toLowerCase().replaceAll("’", "'").trim()
    .replace(/^(?:please\s+)?(?:(?:what(?:'s| is)?|calculate|compute|evaluate)\s+|(?:how much is)\s+)/, "")
    .replace(/(?:\s+please)?[?=.]?$/, "").trim()
    .replace(/\b(plus|minus|times|multiplied\s+by|divided\s+by)\b/g, words => OPERATORS[words.split(/\s+/)[0]])
    .replace(/[×·]/g, "*").replaceAll("÷", "/").replaceAll("−", "-");
  if (expression.length > 160) return;
  const tokens = expression.match(/\d+(?:\.\d+)?|\.\d+|[()+*/-]/g) ?? [];
  if (tokens.join("") !== expression.replace(/\s/g, "")) return;
  let position = 0;
  let operations = 0;
  let dividedByZero = false;

  function value() {
    const token = tokens[position++];
    if (token === "+" || token === "-") {
      const operand = value();
      return operand && token === "-" ? [-operand[0], operand[1]] : operand;
    }
    if (token === "(") {
      const result = sum();
      return tokens[position++] === ")" ? result : null;
    }
    if (!NUMBER.test(token ?? "") || Number(token) >= MAX_MAGNITUDE) return null;
    const [whole, decimal = ""] = token.split(".");
    return [BigInt(whole + decimal), 10n ** BigInt(decimal.length)];
  }

  function product() {
    let result = value();
    while (tokens[position] === "*" || tokens[position] === "/") {
      const operator = tokens[position++];
      const operand = value();
      if (!result || !operand) return null;
      const [left, leftDenominator] = result;
      const [right, rightDenominator] = operand;
      operations++;
      if (operator === "/" && right === 0n) {
        dividedByZero = true;
        result = [0n, 1n];
      } else {
        result = operator === "*"
          ? [left * right, leftDenominator * rightDenominator]
          : [left * rightDenominator, leftDenominator * right];
      }
    }
    return result;
  }

  function sum() {
    let result = product();
    while (tokens[position] === "+" || tokens[position] === "-") {
      const operator = tokens[position++];
      const operand = product();
      if (!result || !operand) return null;
      const [left, leftDenominator] = result;
      const [right, rightDenominator] = operand;
      const signedRight = operator === "+" ? right : -right;
      operations++;
      result = [left * rightDenominator + signedRight * leftDenominator, leftDenominator * rightDenominator];
    }
    return result;
  }

  const fraction = sum();
  if (position !== tokens.length || !operations || !fraction) return;
  const result = Number(fraction[0]) / Number(fraction[1]);
  if (!Number.isFinite(result) || Math.abs(result) >= MAX_MAGNITUDE) return;
  return {
    expression: tokens.join(" ").replace(/\( /g, "(").replace(/ \)/g, ")"),
    result: dividedByZero ? "Division by zero is undefined." : String(Number(result.toPrecision(15))),
    dividedByZero,
  };
}

export function arithmeticReply(messages) {
  const latest = messages.at(-1)?.text ?? "";
  const direct = calculate(latest);
  if (direct) return direct.result;
  if (!/^(?:lol[,\s]+)?(?:no[,\s]+)?(?:that(?:'s|’s| is) (?:wrong|incorrect)|wrong|try again|check (?:that|your (?:math|answer))|are you sure)[.!?]*$/i.test(latest.trim())) return;
  const previous = messages.at(-3);
  if (previous?.role !== "user" || messages.at(-2)?.role !== "assistant") return;
  const checked = calculate(previous.text);
  if (!checked) return;
  if (checked.dividedByZero) return checked.result;
  return "I checked again. " + checked.expression + " = " + checked.result + ".";
}
