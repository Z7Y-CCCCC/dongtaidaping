'use strict';

const MAX_EXPRESSION_LENGTH = 256;
const MAX_NESTING_DEPTH = 32;

/**
 * Evaluate the deliberately small numeric expression language.
 *
 * Supported syntax: named variables, decimal numbers, +, -, *, / and
 * parentheses. The parser never executes JavaScript, so expressions restored
 * from a backup cannot escape into the Node.js process.
 */
function evaluateVariableExpression(source, variables = {}, label = '数据') {
    const expression = String(source || '').trim();
    const normalizedVariables = Object.fromEntries(Object.entries(variables || {}).map(([key, value]) => [String(key).toLowerCase(), Number(value)]));
    if (!expression) {
        const first = Object.values(normalizedVariables)[0];
        return Number(first);
    }
    if (expression.length > MAX_EXPRESSION_LENGTH) {
        throw new Error(`${label}公式过长`);
    }
    Object.entries(normalizedVariables).forEach(([key, value]) => {
        if (!/^[a-z_][a-z0-9_]*$/i.test(key)) throw new Error(`${label}公式变量名不合法`);
        if (!Number.isFinite(value)) throw new Error(`${label}公式变量 ${key} 不是有限数字`);
    });

    let index = 0;

    function skipWhitespace() {
        while (index < expression.length && /\s/.test(expression[index])) index += 1;
    }

    function parseNumber() {
        skipWhitespace();
        const start = index;
        let digitsBeforeDot = 0;
        let digitsAfterDot = 0;

        while (index < expression.length && /[0-9]/.test(expression[index])) {
            index += 1;
            digitsBeforeDot += 1;
        }
        if (expression[index] === '.') {
            index += 1;
            while (index < expression.length && /[0-9]/.test(expression[index])) {
                index += 1;
                digitsAfterDot += 1;
            }
        }
        if (digitsBeforeDot + digitsAfterDot === 0) {
            index = start;
            return null;
        }

        const value = Number(expression.slice(start, index));
        if (!Number.isFinite(value)) throw new Error(`${label}公式包含无效数字`);
        return value;
    }

    function parsePrimary(depth) {
        if (depth > MAX_NESTING_DEPTH) throw new Error(`${label}公式括号嵌套过深`);
        skipWhitespace();

        if (expression[index] === '(') {
            index += 1;
            const value = parseAdditive(depth + 1);
            skipWhitespace();
            if (expression[index] !== ')') throw new Error(`${label}公式缺少右括号`);
            index += 1;
            return value;
        }

        if (/[a-z_]/i.test(expression[index] || '')) {
            const start = index;
            index += 1;
            while (index < expression.length && /[a-z0-9_]/i.test(expression[index])) index += 1;
            const name = expression.slice(start, index).toLowerCase();
            if (!Object.prototype.hasOwnProperty.call(normalizedVariables, name)) throw new Error(`${label}公式中的变量 ${name} 未绑定`);
            return normalizedVariables[name];
        }

        const number = parseNumber();
        if (number !== null) return number;
        throw new Error(`${label}公式包含不支持的内容`);
    }

    function parseUnary(depth) {
        skipWhitespace();
        if (expression[index] === '+' || expression[index] === '-') {
            const operator = expression[index];
            index += 1;
            skipWhitespace();
            if (expression[index] === '+' || expression[index] === '-') {
                throw new Error(`${label}公式不允许连续正负号`);
            }
            const value = parseUnary(depth);
            return operator === '-' ? -value : value;
        }
        return parsePrimary(depth);
    }

    function parseMultiplicative(depth) {
        let value = parseUnary(depth);
        while (true) {
            skipWhitespace();
            const operator = expression[index];
            if (operator !== '*' && operator !== '/') break;
            index += 1;
            const right = parseUnary(depth);
            value = operator === '*' ? value * right : value / right;
            if (!Number.isFinite(value)) throw new Error(`${label}公式结果不是有限数字`);
        }
        return value;
    }

    function parseAdditive(depth) {
        let value = parseMultiplicative(depth);
        while (true) {
            skipWhitespace();
            const operator = expression[index];
            if (operator !== '+' && operator !== '-') break;
            index += 1;
            const right = parseMultiplicative(depth);
            value = operator === '+' ? value + right : value - right;
            if (!Number.isFinite(value)) throw new Error(`${label}公式结果不是有限数字`);
        }
        return value;
    }

    const result = parseAdditive(0);
    skipWhitespace();
    if (index !== expression.length) throw new Error(`${label}公式包含多余内容`);
    if (!Number.isFinite(result)) throw new Error(`${label}公式结果不是有限数字`);
    return result;
}

function evaluateMathExpression(source, xValue) {
    return evaluateVariableExpression(source, { x: xValue }, 'PLC ');
}

module.exports = {
    evaluateMathExpression,
    evaluateVariableExpression,
    MAX_EXPRESSION_LENGTH,
    MAX_NESTING_DEPTH
};
