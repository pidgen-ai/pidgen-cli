import type { Readable, Writable } from "node:stream";
import { styleText } from "node:util";
import { DRAIN_TIMEOUT_MS, drained, exitAfterOutput } from "./terminal.js";

/**
 * How `pidgen setup`, the CLI's one interactive command, asks its questions: a select, a
 * multiselect, a text prompt or a confirm, drawn in clack's frame, plus spinners (a task that
 * collapses to one line), task logs (a task whose lines stay on screen, as `--verbose` shows) and
 * waits (a task that runs in the background and answers keys, as setup's sign-in wait does). Each
 * answered question collapses to one `◇` line. The real prompter (`clackPrompter`) wraps
 * `@clack/core`'s prompts, which only setup loads, with a dynamic import, so no other command
 * starts slower, and draws its own spinners and waits; tests drive setup through a scripted
 * prompter that draws the same screens.
 *
 * Ctrl-C at a prompt rejects with `PromptCancelled`. Ctrl-C during a spinner or a wait, and SIGINT
 * or SIGTERM at any time, are reported to `onInterrupt`'s listeners: nothing exits the process.
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
  /** A wait: a live line and a key line, drawn until it ends; see `Wait`. */
  wait(question: WaitQuestion): Wait;
  /** Hears Ctrl-C during a spinner or a wait, and SIGINT or SIGTERM at any time. */
  onInterrupt(listener: (reason: InterruptReason) => void): void;
  /**
   * Ends the prompter: stops hearing signals and keys, and waits (up to two seconds) for what it
   * wrote to reach the terminal.
   */
  close(): Promise<void>;
}

/** What stopped setup outside a prompt: Ctrl-C (or SIGINT), or SIGTERM. */
export type InterruptReason = "ctrl-c" | "sigterm";

export interface WaitQuestion {
  /** The live line, such as "Waiting for you to approve in the browser…". */
  message: string;
  /** The key line under it, such as "Enter open in browser · n new code · Esc other options". */
  keys: string;
}

/** A key a wait answers: Enter, n, or Esc. */
export type WaitKey = "enter" | "new" | "escape";

/**
 * A wait in progress: its live line (redrawn as it changes, and skipped while the terminal is not
 * reading) and the keys it answers. Ctrl-C is reported to `onInterrupt`'s listeners.
 */
export interface Wait {
  /** Replaces the live line. */
  update(message: string): void;
  /** The next key pressed (one already pressed and not yet taken first). */
  key(): Promise<WaitKey>;
  /** Ends the wait in one `◇` line. */
  stop(line: string): void;
  /** Ends the wait without a line. */
  clear(): void;
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
  /** Ends the spinner without leaving a line. */
  clear(): void;
}

export interface TaskLog {
  message(line: string): void;
  success(message: string): void;
  error(message: string): void;
}

/**
 * Ctrl-C (or Escape) at a prompt; or, with `reason`, Ctrl-C or SIGTERM during a task, which stops
 * setup the same way.
 */
export class PromptCancelled extends Error {
  constructor(readonly reason: InterruptReason = "ctrl-c") {
    super(reason === "sigterm" ? "Setup was terminated." : "The prompt was cancelled.");
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

/** A spinner's frames, as clack draws them. */
export const SPINNER_FRAMES = ["◒", "◐", "◓", "◑"] as const;

/** A running wait: its live line under a spinner frame, then its key line. */
export function drawWait(
  message: string,
  keys: string,
  frame: string = SPINNER_FRAMES[0],
  style: Style = plain,
): string {
  return `${style("magenta", frame)}  ${message}\n${style("gray", SYMBOL.bar)}  ${style("dim", keys)}`;
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

/** How often a spinner's or a wait's frame turns, as clack's spinner turns. */
const FRAME_MS = 80;
/** Moves to the start of the line and erases from there down. */
const ERASE = "\u001b[1G\u001b[J";
/** Moves up one line. */
const UP = "\u001b[1A";

/** A terminal output whose queued bytes can be read, and whose handle can be made non-blocking. */
type TerminalOutput = Writable & {
  columns?: number;
  _handle?: { setBlocking?: (blocking: boolean) => void };
};

/** A terminal input that can be put in raw mode. */
type TerminalInput = Readable & { isTTY?: boolean; setRawMode?: (raw: boolean) => void };

/**
 * The prompter on the terminal: clack's prompts (`@clack/core`, drawn with the screens above),
 * loaded here with a dynamic import so that only setup loads them, and its own spinners and waits.
 *
 * Output never holds up the event loop. The terminal's handle is put in non-blocking mode for the
 * whole run (Node writes to a terminal synchronously on Linux and macOS, so a terminal that stops
 * reading would otherwise stop the process, polling and all), and every animated frame is skipped
 * while earlier output is still queued, so a terminal that is not reading has at most one frame
 * waiting for it. Lines that matter (results, errors, the cancel lines) are always written.
 *
 * A spinner or a wait holds standard input in raw mode: what is typed is not echoed, Ctrl-C (byte
 * 0x03) is an interrupt, and a wait answers its keys. SIGINT and SIGTERM are interrupts too. An
 * interrupt is reported to `onInterrupt`'s listeners and never exits the process itself; it asks
 * for the process to exit once the command has returned and its output has drained.
 */
export async function clackPrompter(io: { input: Readable; output: Writable }): Promise<Prompter> {
  const core = await import("@clack/core");
  const input = io.input as TerminalInput;
  const output = io.output as TerminalOutput;
  output._handle?.setBlocking?.(false);
  const style: Style = (format, text) => styleText(format, text);
  const write = (text: string) => void output.write(text);
  /** Whether the terminal has taken everything written so far: animated frames wait for it. */
  const caughtUp = () => output.writableLength === 0;
  /** `text` cut to fit one line of the terminal, so redrawing it erases all of it. */
  const fit = (text: string, room = 4) => {
    const width = Math.max(20, (output.columns || 80) - room);
    return text.length > width ? `${text.slice(0, width - 1)}…` : text;
  };
  const state = (prompt: { state: string }): PromptView["state"] =>
    prompt.state === "submit" || prompt.state === "cancel" || prompt.state === "error"
      ? prompt.state
      : "active";
  const settle = <T>(answer: T | symbol | undefined): T => {
    if (core.isCancel(answer)) throw new PromptCancelled();
    return answer as T;
  };

  // Interrupts: Ctrl-C while a spinner or a wait holds the input, SIGINT, SIGTERM.
  const listeners: Array<(reason: InterruptReason) => void> = [];
  const interrupt = (reason: InterruptReason) => {
    exitAfterOutput();
    for (const listener of listeners) listener(reason);
  };
  const onSigint = () => interrupt("ctrl-c");
  const onSigterm = () => interrupt("sigterm");
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);

  // The input, held in raw mode while a spinner or a wait runs.
  let holders = 0;
  let onKey: ((text: string) => void) | null = null;
  const onData = (chunk: Buffer | string) => {
    const text = chunk.toString();
    if (text.includes("\u0003")) interrupt("ctrl-c");
    else onKey?.(text);
  };
  const hold = () => {
    if (holders++ > 0) return;
    if (input.isTTY) input.setRawMode?.(true);
    input.on("data", onData);
    input.resume();
  };
  const release = () => {
    if (holders === 0 || --holders > 0) return;
    input.off("data", onData);
    if (input.isTTY) input.setRawMode?.(false);
    input.pause();
  };

  /** A frame that turns every `FRAME_MS` and draws `draw(frame)`, skipped while output is queued. */
  const animate = (draw: (frame: string) => void) => {
    let index = 0;
    const turn = () => {
      if (caughtUp()) draw(style("magenta", SPINNER_FRAMES[index]!));
      index = (index + 1) % SPINNER_FRAMES.length;
    };
    turn();
    const timer = setInterval(turn, FRAME_MS);
    timer.unref();
    return () => clearInterval(timer);
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

    // `│`, then `◒  <message>` turning until it ends in its one line (or none).
    spinner() {
      let message = "";
      let stopAnimating: (() => void) | null = null;
      const end = (line: string | null) => {
        if (stopAnimating === null) return;
        stopAnimating();
        stopAnimating = null;
        release();
        write(`${ERASE}${line ?? ""}`);
      };
      return {
        start(text) {
          if (stopAnimating !== null) return;
          message = fit(text);
          hold();
          write(`${style("gray", SYMBOL.bar)}\n`);
          stopAnimating = animate((frame) => write(`${ERASE}${frame}  ${message}`));
        },
        // Drawn with the next frame.
        message: (text) => void (message = fit(text)),
        stop: (line) => end(`${style("green", SYMBOL.submit)}  ${line}\n`),
        // A failed task is drawn `■`, as clack's cancelled spinner is.
        error: (line) => end(`${style("red", SYMBOL.cancel)}  ${line}\n`),
        clear: () => end(null),
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

    // `│`, then the live line under a turning frame and the key line, redrawn in place.
    wait(question) {
      let message = fit(question.message);
      const keys = fit(question.keys);
      let drawn = false;
      let running = true;
      let frame: string = style("magenta", SPINNER_FRAMES[0]);
      const pressed: WaitKey[] = [];
      let waiting: ((key: WaitKey) => void) | null = null;
      const draw = () => {
        if (!caughtUp()) return;
        write(`${drawn ? `${UP}${ERASE}` : ""}${drawWait(message, keys, frame, style)}`);
        drawn = true;
      };
      hold();
      onKey = (text) => {
        const key: WaitKey | null =
          text === "\r" || text === "\n"
            ? "enter"
            : text === "n" || text === "N"
              ? "new"
              : text === "\u001b"
                ? "escape"
                : null;
        if (key === null) return;
        if (waiting !== null) {
          const answer = waiting;
          waiting = null;
          answer(key);
        } else {
          pressed.push(key);
        }
      };
      write(`${style("gray", SYMBOL.bar)}\n`);
      const stopAnimating = animate((turned) => {
        frame = turned;
        draw();
      });
      let next: Promise<WaitKey> | null = null;
      const end = (line: string | null) => {
        if (!running) return;
        running = false;
        stopAnimating();
        onKey = null;
        release();
        write(`${drawn ? `${UP}${ERASE}` : ERASE}${line ?? ""}`);
      };
      return {
        update(text) {
          message = fit(text);
          draw();
        },
        key() {
          const first = pressed.shift();
          if (first !== undefined) return Promise.resolve(first);
          next ??= new Promise<WaitKey>((resolveKey) => {
            waiting = (key) => {
              next = null;
              resolveKey(key);
            };
          });
          return next;
        },
        stop: (line) => end(`${style("green", SYMBOL.submit)}  ${line}\n`),
        clear: () => end(null),
      };
    },

    onInterrupt(listener) {
      listeners.push(listener);
    },

    async close() {
      process.off("SIGINT", onSigint);
      process.off("SIGTERM", onSigterm);
      listeners.length = 0;
      while (holders > 0) release();
      await drained(output, DRAIN_TIMEOUT_MS);
    },
  };
}
