/**
 * Pure formatting of evaluation results for the inline decoration and the
 * results channel (kept free of the vscode module so it can be unit tested).
 */
import type { LiveEvaluation } from '../common/live';

const INLINE_LIMIT = 120;

/** One line to show after the evaluated form. */
export function inlineText(result: LiveEvaluation): string {
  const text = result.ok ? (result.values.length ? result.values.join(', ') : '; no values') : `error: ${result.error ?? 'error'}`;
  const oneLine = text.replace(/\s*\n\s*/g, ' ');
  return oneLine.length > INLINE_LIMIT ? `${oneLine.slice(0, INLINE_LIMIT - 1)}…` : oneLine;
}

/** The first line of the evaluated text, shortened, for the results channel heading. */
export function formSummary(text: string, limit = 72): string {
  const first = text.trim().split('\n')[0]?.trim() ?? '';
  return first.length > limit ? `${first.slice(0, limit - 1)}…` : first;
}

/** The results channel entry: heading, captured output, values or error with backtrace. */
export function channelText(text: string, result: LiveEvaluation): string {
  const lines: string[] = [`;; ${formSummary(text)}`];
  if (result.output.trim()) lines.push(result.output.replace(/\n$/, ''));
  if (result.ok) {
    if (result.values.length) for (const value of result.values) lines.push(`=> ${value}`);
    else lines.push('=> ; no values');
  } else {
    lines.push(`;; error: ${result.error ?? 'error'}`);
    for (const frame of result.backtrace.slice(0, 12)) lines.push(`;;   ${frame}`);
  }
  return `${lines.join('\n')}\n`;
}
