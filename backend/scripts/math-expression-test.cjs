const assert = require('assert');
const { evaluateMathExpression, evaluateVariableExpression, MAX_EXPRESSION_LENGTH } = require('../utils/mathExpression');

function mustReject(expression) {
    assert.throws(() => evaluateMathExpression(expression, 10), Error, `应拒绝公式：${expression}`);
}

assert.strictEqual(evaluateMathExpression('x * 0.1 + 2', 30), 5);
assert.strictEqual(evaluateMathExpression('(X - 2) / 4', 18), 4);
assert.strictEqual(evaluateMathExpression('-.5 * x', 8), -4);
assert.strictEqual(evaluateMathExpression('x / (2 + 3)', 20), 4);
assert.strictEqual(evaluateVariableExpression('(a / b) * 100', { a: 45, b: 60 }), 75);
assert.strictEqual(evaluateVariableExpression('temperature - ambient', { temperature: 820, ambient: 25 }), 795);
assert.throws(() => evaluateVariableExpression('a + missing', { a: 1 }), /未绑定/);

mustReject('x.constructor.constructor("return process")()');
mustReject('global.process.exit()');
mustReject('x / 0');
mustReject('x ** 2');
mustReject('--x');
mustReject('('.repeat(40) + 'x' + ')'.repeat(40));
mustReject(`x+${'1'.repeat(MAX_EXPRESSION_LENGTH + 1)}`);

console.log(JSON.stringify({
    success: true,
    checks: {
        arithmetic: true,
        caseInsensitiveVariable: true,
        unaryAndDecimal: true,
        multipleNamedVariables: true,
        codeExecutionRejected: true,
        nonFiniteRejected: true,
        complexityLimited: true
    }
}, null, 2));
