import type { Readable, Writable } from "node:stream";
import { styleText } from "node:util";

/**
 * How `pidgen setup`, the CLI's one interactive command, asks its questions: a select, a
 * multiselect, a text prompt or a confirm, drawn in clack's frame, plus spinners (a task that
 * collapses to one line) and task logs (a task whose lines stay on screen, as `--verbose` shows).
 * Each answered question collapses to one `◇` line. The real prompter (`clackPrompter`) wraps
 * `@clack/prompts`, which only setup loads, with a dynamic import, so no other command starts
 * slower; tests drive setup through a scripted prompter that draws the same screens.
 *
 * Ctrl-C at a prompt rejects with `PromptCancelled`.
 */
export interface Prompter {
  /** `┌  <title>`: the top of setup's frame. */
  intro(title: string): void;
  /** `└  <message>`: the bottom of setup's frame. */
  outro(message: string): void;
  /** `■  <message>` then `└  <next>`: setup stopped at a prompt the person cancelled. */
  cancel(message: string, next: string): void;
  select<T>(prompt: SelectQuestion<T>): Promise<T>;
  multiselect<T>(prompt: MultiselectQuestion<T>): Promise<T[]>;
  text(prompt: TextQuestion): Promise<string>;
  confirm(prompt: ConfirmQuestion): Promise<boolean>;
  spinner(): Spinner;
  taskLog(title: string): TaskLog;
}

export interface PromptOption<T> {
  value: T;
  label: string;
  /** Shown after the label, in a column. */
  hint?: string;
  /** Shown, and cannot be chosen. */
  disabled?: boolean;
}

export interface SelectQuestion<T> {
  message: string;
  options: readonly PromptOption<T>[];
  /** The option the cursor starts on; the first enabled one when absent. */
  initialValue?: T;
  /** One line under the options. */
  footer?: string;
  /** The one line the answered question collapses to; `<message> · <label>` by default. */
  collapse?: (value: T) => string;
}

export interface MultiselectQuestion<T> {
  message: string;
  options: readonly PromptOption<T>[];
  /** The options ticked at the start. */
  initialValues?: readonly T[];
  /** When set, confirming none keeps the question open with this message. */
  required?: string;
  footer?: string;
  collapse?: (values: T[]) => string;
}

export interface TextQuestion {
  message: string;
  /** The answer an empty input gives, shown as the placeholder. */
  defaultValue?: string;
  /** Returns the message that keeps the question open, or `undefined` to accept the answer. */
  validate?: (value: string) => string | undefined;
  collapse?: (value: string) => string;
}

export interface ConfirmQuestion {
  message: string;
  /** Text under the message: one line, or several separated by `\n`. */
  detail?: string;
  /** The label of yes (default "Yes"). */
  active?: string;
  /** The label of no (default "No"). */
  inactive?: string;
  /** The answer the cursor starts on (default yes). */
  initialValue?: boolean;
  /** One line under the choices. */
  footer?: string;
  collapse?: (value: boolean) => string;
}

export interface Spinner {
  start(message: string): void;
  message(message: string): void;
  stop(message: string): void;
  error(message: string): void;
}

export interface TaskLog {
  message(line: string): void;
  success(message: string): void;
  error(message: string): void;
}

/** Ctrl-C (or Escape) at a prompt. */
export class PromptCancelled extends Error {
  constructor() {
    super("The prompt was cancelled.");
    this.name = "PromptCancelled";
  }
}

// ---------------------------------------------------------------------------------------------
// Drawing: one set of screens, used by the real prompter and the scripted one tests use

/** clack's symbols. */
export const SYMBOL = {
  start: "┌",
  bar: "│",
  end: "└",
  active: "◆",
  submit: "◇",
  cancel: "■",
  warn: "▲",
  radioOn: "●",
  radioOff: "○",
  checked: "◼",
  unchecked: "◻",
} as const;

type Format = Parameters<typeof styleText>[0];
/** Styles text for the terminal; `plain` leaves it as it is. */
export type Style = (format: Format, text: string) => string;
export const plain: Style = (_format, text) => text;

/** What a prompt looks like right now. */
export interface PromptView {
  state: "active" | "error" | "submit" | "cancel";
  /** The option the cursor is on. */
  cursor: number;
  /** The message that keeps the question open (`error` state). */
  error?: string;
}

/** The text prompt's view: what has been typed, with the cursor drawn in. */
export interface TextView extends PromptView {
  input: string;
}

/** The `▲` line of a question kept open, or the bottom of an open one. */
function bottom(view: PromptView, style: Style): string {
  return view.state === "error"
    ? style("yellow", `${SYMBOL.warn}  ${view.error ?? ""}`)
    : style("cyan", SYMBOL.end);
}

function header(message: string, style: Style): string[] {
  return [style("gray", SYMBOL.bar), `${style("cyan", SYMBOL.active)}  ${message}`];
}

/** `│\n◇  <line>`: what an answered question leaves on screen. */
export function drawCollapsed(line: string, style: Style = plain): string {
  return `${style("gray", SYMBOL.bar)}\n${style("green", SYMBOL.submit)}  ${line}`;
}

/** What a cancelled question leaves on screen: the frame's bar, nothing of the question. */
function drawCancelled(style: Style): string {
  return style("gray", SYMBOL.bar);
}

function inner(text: string, style: Style): string {
  return `${style("cyan", SYMBOL.bar)}  ${text}`;
}

/** The option rows: the marker, the label, and the hint in a column after the widest hinted label. */
function rows<T>(
  options: readonly PromptOption<T>[],
  marker: (option: PromptOption<T>, index: number) => string,
  cursor: number,
  style: Style,
): string[] {
  const width = Math.max(
    0,
    ...options.filter((option) => option.hint).map((option) => option.label.length),
  );
  return options.map((option, index) => {
    const label = option.hint ? option.label.padEnd(width) : option.label;
    const text = `${label}${option.hint ? `   ${option.hint}` : ""}`;
    const shown = option.disabled
      ? style("dim", text)
      : index === cursor
        ? text
        : style("dim", text);
    return inner(`${marker(option, index)} ${shown}`, style);
  });
}

export function selectCollapse<T>(question: SelectQuestion<T>, value: T): string {
  if (question.collapse) return question.collapse(value);
  const option = question.options.find((entry) => entry.value === value);
  return `${question.message} · ${option?.label ?? String(value)}`;
}

export function drawSelect<T>(question: SelectQuestion<T>, view: PromptView, style: Style): string {
  if (view.state === "submit") {
    return drawCollapsed(selectCollapse(question, question.options[view.cursor]!.value), style);
  }
  if (view.state === "cancel") return drawCancelled(style);
  const single = question.options.length === 1;
  const lines = [
    ...header(question.message, style),
    ...(single
      ? [inner(question.options[0]!.label, style)]
      : rows(
          question.options,
          (option, index) =>
            option.disabled
              ? style("dim", SYMBOL.radioOff)
              : index === view.cursor
                ? style("green", SYMBOL.radioOn)
                : style("dim", SYMBOL.radioOff),
          view.cursor,
          style,
        )),
    ...(question.footer ? [inner(style("dim", question.footer), style)] : []),
    bottom(view, style),
  ];
  return lines.join("\n");
}

export function multiselectCollapse<T>(question: MultiselectQuestion<T>, values: T[]): string {
  if (question.collapse) return question.collapse(values);
  const labels = question.options
    .filter((option) => values.includes(option.value))
    .map((option) => option.label);
  return `${question.message} · ${labels.length > 0 ? labels.join(", ") : "none"}`;
}

export function drawMultiselect<T>(
  question: MultiselectQuestion<T>,
  view: PromptView,
  values: readonly T[],
  style: Style,
): string {
  if (view.state === "submit")
    return drawCollapsed(multiselectCollapse(question, [...values]), style);
  if (view.state === "cancel") return drawCancelled(style);
  const lines = [
    ...header(question.message, style),
    ...rows(
      question.options,
      (option, index) => {
        if (option.disabled) return style("dim", SYMBOL.unchecked);
        const ticked = values.includes(option.value);
        const color = index === view.cursor ? "cyan" : ticked ? "green" : "dim";
        return style(color, ticked ? SYMBOL.checked : SYMBOL.unchecked);
      },
      view.cursor,
      style,
    ),
    ...(question.footer ? [inner(style("dim", question.footer), style)] : []),
    bottom(view, style),
  ];
  return lines.join("\n");
}

export function textCollapse(question: TextQuestion, value: string): string {
  return question.collapse ? question.collapse(value) : `${question.message} · ${value}`;
}

export function drawText(question: TextQuestion, view: TextView, style: Style): string {
  if (view.state === "submit") {
    return drawCollapsed(
      textCollapse(question, view.input || (question.defaultValue ?? "")),
      style,
    );
  }
  if (view.state === "cancel") return drawCancelled(style);
  const shown =
    view.input === "" && question.defaultValue ? style("dim", question.defaultValue) : view.input;
  return [...header(question.message, style), inner(shown, style), bottom(view, style)].join("\n");
}

export function confirmCollapse(question: ConfirmQuestion, value: boolean): string {
  if (question.collapse) return question.collapse(value);
  return `${question.message} · ${value ? (question.active ?? "Yes") : (question.inactive ?? "No")}`;
}

/** The confirm's view: `cursor` 0 is yes, 1 is no. */
export function drawConfirm(question: ConfirmQuestion, view: PromptView, style: Style): string {
  if (view.state === "submit")
    return drawCollapsed(confirmCollapse(question, view.cursor === 0), style);
  if (view.state === "cancel") return drawCancelled(style);
  const choice = (label: string, on: boolean) =>
    on ? `${style("green", SYMBOL.radioOn)} ${label}` : style("dim", `${SYMBOL.radioOff} ${label}`);
  const lines = [
    ...header(question.message, style),
    ...(question.detail ? question.detail.split("\n").map((line) => inner(line, style)) : []),
    inner(
      `${choice(question.active ?? "Yes", view.cursor === 0)}  ${choice(question.inactive ?? "No", view.cursor === 1)}`,
      style,
    ),
    ...(question.footer ? [inner(style("dim", question.footer), style)] : []),
    bottom(view, style),
  ];
  return lines.join("\n");
}

/** `│\n■  <line>`: what a failed task leaves on screen. */
export function drawFailed(line: string, style: Style = plain): string {
  return `${style("gray", SYMBOL.bar)}\n${style("red", SYMBOL.cancel)}  ${line}`;
}

/** `│\n◒  <title>`: the top of a task log, which stays on screen. */
export function drawTaskTitle(title: string, style: Style = plain): string {
  return `${style("gray", SYMBOL.bar)}\n${style("magenta", "◒")}  ${title}`;
}

/** `│  <line>`: one line under a task log's title, or of a failed task's last output. */
export function drawTaskLine(line: string, style: Style = plain): string {
  return `${style("gray", SYMBOL.bar)}  ${line}`;
}

export function drawIntro(title: string, style: Style = plain): string {
  return `${style("gray", SYMBOL.start)}  ${title}\n`;
}

export function drawOutro(message: string, style: Style = plain): string {
  return `${style("gray", SYMBOL.bar)}\n${style("gray", SYMBOL.end)}  ${message}\n`;
}

export function drawCancel(message: string, next: string, style: Style = plain): string {
  return `${style("red", SYMBOL.cancel)}  ${message}\n${style("gray", SYMBOL.end)}  ${next}\n`;
}

/** The index of the option whose value is `value`, else the first enabled one. */
export function initialCursor<T>(
  options: readonly PromptOption<T>[],
  value: T | undefined,
): number {
  const found = value === undefined ? -1 : options.findIndex((option) => option.value === value);
  if (found >= 0 && !options[found]!.disabled) return found;
  return Math.max(
    0,
    options.findIndex((option) => !option.disabled),
  );
}

// ---------------------------------------------------------------------------------------------
// The real prompter

/**
 * The prompter on the terminal: clack's prompts (`@clack/core`, drawn with the screens above) and
 * its spinner and task log (`@clack/prompts`), both loaded here with a dynamic import so that only
 * setup loads them.
 */
export async function clackPrompter(io: { input: Readable; output: Writable }): Promise<Prompter> {
  const [core, prompts] = await Promise.all([import("@clack/core"), import("@clack/prompts")]);
  const { input, output } = io;
  const style: Style = (format, text) => styleText(format, text);
  const write = (text: string) => void output.write(text);
  const state = (prompt: { state: string }): PromptView["state"] =>
    prompt.state === "submit" || prompt.state === "cancel" || prompt.state === "error"
      ? prompt.state
      : "active";
  const settle = <T>(answer: T | symbol | undefined): T => {
    if (core.isCancel(answer)) throw new PromptCancelled();
    return answer as T;
  };

  return {
    intro: (title) => write(drawIntro(title, style)),
    outro: (message) => write(drawOutro(message, style)),
    cancel: (message, next) => write(drawCancel(message, next, style)),

    async select<T>(question: SelectQuestion<T>): Promise<T> {
      const prompt = new core.SelectPrompt<PromptOption<T>>({
        input,
        output,
        options: [...question.options],
        initialValue:
          question.options[initialCursor(question.options, question.initialValue)]!.value,
        render() {
          return drawSelect(
            question,
            { state: state(this), cursor: this.cursor, error: this.error },
            style,
          );
        },
      });
      return settle<T>(await prompt.prompt());
    },

    async multiselect<T>(question: MultiselectQuestion<T>): Promise<T[]> {
      const prompt = new core.MultiSelectPrompt<PromptOption<T>>({
        input,
        output,
        options: [...question.options],
        initialValues: [...(question.initialValues ?? [])],
        required: false,
        validate: (values) =>
          question.required !== undefined && (values ?? []).length === 0
            ? question.required
            : undefined,
        render() {
          return drawMultiselect(
            question,
            { state: state(this), cursor: this.cursor, error: this.error },
            this.value ?? [],
            style,
          );
        },
      });
      return settle<T[]>(await prompt.prompt());
    },

    async text(question: TextQuestion): Promise<string> {
      const answer = (value: string | undefined) =>
        value === undefined || value === "" ? (question.defaultValue ?? "") : value;
      const prompt = new core.TextPrompt({
        input,
        output,
        ...(question.defaultValue !== undefined ? { defaultValue: question.defaultValue } : {}),
        validate: (value) => question.validate?.(answer(value)),
        render() {
          return drawText(
            question,
            {
              state: state(this),
              cursor: 0,
              error: this.error,
              input: this.state === "submit" ? this.userInput : this.userInputWithCursor,
            },
            style,
          );
        },
      });
      return answer(settle<string | undefined>(await prompt.prompt()));
    },

    async confirm(question: ConfirmQuestion): Promise<boolean> {
      const prompt = new core.ConfirmPrompt({
        input,
        output,
        active: question.active ?? "Yes",
        inactive: question.inactive ?? "No",
        initialValue: question.initialValue ?? true,
        render() {
          return drawConfirm(
            question,
            { state: state(this), cursor: this.value === false ? 1 : 0 },
            style,
          );
        },
      });
      return settle<boolean>(await prompt.prompt());
    },

    spinner() {
      const spin = prompts.spinner({ output });
      return {
        start: (message) => spin.start(message),
        message: (message) => spin.message(message),
        stop: (message) => spin.stop(message),
        // clack's cancel draws `■`, as a failed task is drawn.
        error: (message) => spin.cancel(message),
      };
    },

    // A task log is drawn line by line and kept after it ends: the title, each line under it, then
    // its result, as `--verbose` shows a task.
    taskLog(title) {
      write(`${drawTaskTitle(title, style)}\n`);
      return {
        message: (line) => write(`${drawTaskLine(style("dim", line), style)}\n`),
        success: (message) => write(`${drawCollapsed(message, style)}\n`),
        error: (message) => write(`${drawFailed(message, style)}\n`),
      };
    },
  };
}
