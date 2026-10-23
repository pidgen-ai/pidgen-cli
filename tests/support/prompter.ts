import {
  drawCancel,
  drawCollapsed,
  drawConfirm,
  drawFailed,
  drawIntro,
  drawMultiselect,
  drawOutro,
  drawSelect,
  drawTaskLine,
  drawTaskTitle,
  drawText,
  initialCursor,
  plain,
  PromptCancelled,
  type ConfirmQuestion,
  type InterruptReason,
  type WaitKey,
  type MultiselectQuestion,
  type PromptOption,
  type Prompter,
  type SelectQuestion,
  type TextQuestion,
} from "../../src/core/prompter.js";

/** Ctrl-C at the prompt. */
export const CANCEL = Symbol("Ctrl-C");

/**
 * One scripted answer. `""` presses Enter on what the prompt starts with (its default). A select
 * takes an option's value or label; a multiselect the values or labels separated by spaces, or
 * `"none"`; a confirm `"y"` or `"n"`; a text prompt what is typed. A function answers from the
 * prompt as drawn, and may act first (as a person running a command before confirming).
 */
export type Answer =
  string | boolean | typeof CANCEL | ((asked: AskedPrompt) => Answer | Promise<Answer>);

export interface AskedPrompt {
  kind: "select" | "multiselect" | "text" | "confirm";
  message: string;
  /** The open prompt as it is drawn (without colour), with its `▲` line when kept open. */
  screen: string;
  /** A select's or multiselect's options. */
  options: Array<{ value: unknown; label: string; hint?: string; disabled?: boolean }>;
}

export interface ScriptedPrompter {
  prompter: Prompter;
  /** Each screen drawn while a question was open, in order: one per answer taken. */
  asked: AskedPrompt[];
  /** Each message a spinner showed while it ran (start, then each change), in order. */
  spinners: string[];
  /** Each wait, in the order they started. */
  waits: ScriptedWait[];
  /** Ctrl-C during a spinner or a wait, or SIGTERM: what the real prompter reports. */
  interrupt(reason: InterruptReason): void;
}

/** A wait as the scripted prompter ran it: what it showed, and a way to press its keys. */
export interface ScriptedWait {
  message: string;
  keys: string;
  /** Each live line it showed (the first is `message`), in order. */
  lines: string[];
  /** The line it ended in, `null` when it ended without one, `undefined` while it runs. */
  ended: string | null | undefined;
  /** Presses Enter, n or Esc. */
  press(key: WaitKey): void;
}

export interface ScriptedHooks {
  /** Called as each question opens, before it takes its answer. */
  onAsk?: (asked: AskedPrompt) => void;
  /** Called as each spinner starts, with its message. */
  onSpinner?: (message: string) => void;
  /** Called as each wait starts. */
  onWait?: (wait: ScriptedWait) => void;
}

/**
 * A prompter that answers from `answers`, in order, and writes to `write` what the real one leaves
 * on the terminal: each answered question's one `◇` line, the intro, outro and cancel lines, and
 * the spinners' and task logs' lines. A question with no answer left fails the test.
 */
export function scriptedPrompter(
  write: (text: string) => void,
  answers: Answer[],
  hooks: ScriptedHooks | ((asked: AskedPrompt) => void) = {},
): ScriptedPrompter {
  const {
    onAsk = () => undefined,
    onSpinner,
    onWait,
  } = typeof hooks === "function" ? { onAsk: hooks } : hooks;
  const asked: AskedPrompt[] = [];
  const spinners: string[] = [];
  const waits: ScriptedWait[] = [];
  const listeners: Array<(reason: InterruptReason) => void> = [];

  async function take(
    entry: Omit<AskedPrompt, "screen" | "options">,
    screen: string,
    options: readonly PromptOption<unknown>[] = [],
  ): Promise<Answer> {
    const shown: AskedPrompt = {
      ...entry,
      screen,
      options: options.map((option) => ({ ...option })),
    };
    asked.push(shown);
    onAsk(shown);
    let answer = answers.shift();
    if (answer === undefined) throw new Error(`unexpected question:\n${screen}`);
    while (typeof answer === "function") answer = await answer(shown);
    if (answer === CANCEL) {
      write(`${drawCancelledBar()}\n`);
      throw new PromptCancelled();
    }
    return answer;
  }

  function optionFor<T>(options: readonly PromptOption<T>[], word: string): number {
    const wanted = word.trim().toLowerCase();
    const index = options.findIndex(
      (option) =>
        String(option.value).toLowerCase() === wanted || option.label.toLowerCase() === wanted,
    );
    if (index < 0) throw new Error(`no option "${word}" among ${options.map((o) => o.label)}`);
    if (options[index]!.disabled) throw new Error(`option "${word}" is disabled`);
    return index;
  }

  const prompter: Prompter = {
    intro: (title) => write(drawIntro(title)),
    outro: (message) => write(drawOutro(message)),
    cancel: (message, next) => write(drawCancel(message, next)),

    async select<T>(question: SelectQuestion<T>): Promise<T> {
      const start = initialCursor(question.options, question.initialValue);
      const screen = drawSelect(question, { state: "active", cursor: start }, plain);
      const answer = await take(
        { kind: "select", message: question.message },
        screen,
        question.options,
      );
      const cursor = answer === "" ? start : optionFor(question.options, String(answer));
      write(`${drawSelect(question, { state: "submit", cursor }, plain)}\n`);
      return question.options[cursor]!.value;
    },

    async multiselect<T>(question: MultiselectQuestion<T>): Promise<T[]> {
      const start = [...(question.initialValues ?? [])];
      let screen = drawMultiselect(question, { state: "active", cursor: 0 }, start, plain);
      for (;;) {
        const answer = await take(
          { kind: "multiselect", message: question.message },
          screen,
          question.options,
        );
        const words = String(answer).trim().toLowerCase();
        const values =
          answer === ""
            ? start
            : words === "none"
              ? []
              : words
                  .split(/[\s,]+/)
                  .map((word) => question.options[optionFor(question.options, word)]!.value);
        const chosen = question.options
          .filter((option) => values.includes(option.value))
          .map((option) => option.value);
        if (question.required !== undefined && chosen.length === 0) {
          screen = drawMultiselect(
            question,
            { state: "error", cursor: 0, error: question.required },
            chosen,
            plain,
          );
          continue;
        }
        write(`${drawMultiselect(question, { state: "submit", cursor: 0 }, chosen, plain)}\n`);
        return chosen;
      }
    },

    async text(question: TextQuestion): Promise<string> {
      let screen = drawText(question, { state: "active", cursor: 0, input: "" }, plain);
      for (;;) {
        const answer = await take({ kind: "text", message: question.message }, screen);
        const typed = String(answer);
        const value = typed === "" ? (question.defaultValue ?? "") : typed;
        const error = question.validate?.(value);
        if (error !== undefined) {
          screen = drawText(question, { state: "error", cursor: 0, error, input: typed }, plain);
          continue;
        }
        write(`${drawText(question, { state: "submit", cursor: 0, input: value }, plain)}\n`);
        return value;
      }
    },

    async confirm(question: ConfirmQuestion): Promise<boolean> {
      const start = question.initialValue ?? true;
      const screen = drawConfirm(question, { state: "active", cursor: start ? 0 : 1 }, plain);
      const answer = await take({ kind: "confirm", message: question.message }, screen);
      const value =
        answer === ""
          ? start
          : typeof answer === "boolean"
            ? answer
            : /^(y|yes)$/i.test(String(answer))
              ? true
              : /^(n|no)$/i.test(String(answer))
                ? false
                : (() => {
                    throw new Error(`a confirm takes y or n, not "${String(answer)}"`);
                  })();
      write(`${drawConfirm(question, { state: "submit", cursor: value ? 0 : 1 }, plain)}\n`);
      return value;
    },

    // A spinner leaves only its result line; what it showed while running is recorded.
    spinner() {
      return {
        start: (message) => {
          spinners.push(message);
          onSpinner?.(message);
        },
        message: (message) => void spinners.push(message),
        stop: (message) => write(`${drawCollapsed(message)}\n`),
        error: (message) => write(`${drawFailed(message)}\n`),
        clear: () => undefined,
      };
    },

    taskLog(title) {
      write(`${drawTaskTitle(title)}\n`);
      return {
        message: (line) => write(`${drawTaskLine(line)}\n`),
        success: (message) => write(`${drawCollapsed(message)}\n`),
        error: (message) => write(`${drawFailed(message)}\n`),
      };
    },

    // A wait, like a spinner, leaves only its result line; its live lines are recorded, and the
    // test presses its keys.
    wait(question) {
      const pressed: WaitKey[] = [];
      let waiting: ((key: WaitKey) => void) | null = null;
      const wait: ScriptedWait = {
        message: question.message,
        keys: question.keys,
        lines: [question.message],
        ended: undefined,
        press(key) {
          if (wait.ended !== undefined) throw new Error(`pressed ${key} after the wait ended`);
          if (waiting === null) {
            pressed.push(key);
            return;
          }
          const answer = waiting;
          waiting = null;
          answer(key);
        },
      };
      waits.push(wait);
      let next: Promise<WaitKey> | null = null;
      const end = (line: string | null) => {
        if (wait.ended !== undefined) return;
        wait.ended = line;
        if (line !== null) write(`${drawCollapsed(line)}\n`);
      };
      const running = {
        update: (message: string) => void wait.lines.push(message),
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
        stop: (line: string) => end(line),
        clear: () => end(null),
      };
      onWait?.(wait);
      return running;
    },

    onInterrupt(listener) {
      listeners.push(listener);
    },

    close: () => Promise.resolve(),
  };
  const interrupt = (reason: InterruptReason) => {
    for (const listener of listeners) listener(reason);
  };
  return { prompter, asked, spinners, waits, interrupt };
}

function drawCancelledBar(): string {
  return "│";
}
