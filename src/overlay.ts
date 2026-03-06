export type UnlockSubmitHandler = (passcode: string) => Promise<boolean>;

export class LockOverlay {
  private rootEl: HTMLDivElement | null = null;
  private inputEl: HTMLInputElement | null = null;
  private submitButtonEl: HTMLButtonElement | null = null;
  private errorEl: HTMLDivElement | null = null;
  private focusGuardTimer: number | null = null;
  private readonly focusGuardHandler = (event: FocusEvent): void => {
    if (!this.rootEl || !this.inputEl) {
      return;
    }

    const target = event.target instanceof Node ? event.target : null;
    if (!target || !this.rootEl.contains(target)) {
      event.preventDefault();
      this.focusInput();
    }
  };

  constructor(
    private readonly onSubmit: UnlockSubmitHandler,
    private readonly win: Window,
    private readonly doc: Document
  ) {}

  isVisible(): boolean {
    return this.rootEl !== null;
  }

  getRoot(): HTMLDivElement | null {
    return this.rootEl;
  }

  show(): void {
    if (this.rootEl) {
      this.focusInput();
      return;
    }

    const root = this.doc.createElement("div");
    root.className = "ls-overlay";
    root.tabIndex = -1;
    root.setAttribute("aria-modal", "true");
    root.setAttribute("role", "dialog");

    const topInset = this.getWindowControlInset();
    root.style.position = "fixed";
    root.style.left = "0";
    root.style.right = "0";
    root.style.bottom = "0";
    root.style.top = topInset > 0 ? `${topInset}px` : "0";
    root.style.zIndex = "2147483647";
    root.style.display = "grid";
    root.style.placeItems = "center";
    root.style.padding = "24px";
    root.style.background = "#080b11";
    root.style.opacity = "1";
    if (topInset > 0) {
      root.style.inset = `${topInset}px 0 0 0`;
    }

    const panel = this.doc.createElement("div");
    panel.className = "ls-panel";
    panel.style.width = "min(420px, 100%)";
    panel.style.borderRadius = "16px";
    panel.style.border = "1px solid #202736";
    panel.style.background = "linear-gradient(180deg, #131926 0%, #0f1521 100%)";
    panel.style.boxShadow = "0 24px 80px rgba(0, 0, 0, 0.55)";
    panel.style.padding = "24px";

    const badge = this.doc.createElement("div");
    badge.className = "ls-badge";
    badge.textContent = "受保护工作区";
    badge.style.display = "inline-block";
    badge.style.fontSize = "11px";
    badge.style.letterSpacing = "0.1em";
    badge.style.textTransform = "uppercase";
    badge.style.color = "#9eb1d6";
    badge.style.background = "#1f2b45";
    badge.style.border = "1px solid #314a7d";
    badge.style.borderRadius = "999px";
    badge.style.padding = "4px 10px";
    badge.style.marginBottom = "14px";

    const title = this.doc.createElement("h2");
    title.className = "ls-title";
    title.textContent = "编辑器已锁定";
    title.style.margin = "0";
    title.style.fontSize = "24px";
    title.style.color = "#f2f5fc";

    const subtitle = this.doc.createElement("p");
    subtitle.className = "ls-subtitle";
    subtitle.textContent = "请输入访问授权码以继续使用 Obsidian。";
    subtitle.style.margin = "8px 0 0";
    subtitle.style.color = "#b4bfd6";
    subtitle.style.lineHeight = "1.5";

    const form = this.doc.createElement("form");
    form.className = "ls-form";
    form.style.marginTop = "18px";
    form.style.display = "grid";
    form.style.gap = "10px";

    const input = this.doc.createElement("input");
    input.className = "ls-input";
    input.type = "password";
    input.autocomplete = "off";
    input.placeholder = "请输入访问授权码";
    input.style.width = "100%";
    input.style.height = "40px";
    input.style.borderRadius = "10px";
    input.style.border = "1px solid #3b4761";
    input.style.background = "#0c1220";
    input.style.color = "#f4f8ff";
    input.style.padding = "0 12px";
    input.style.fontSize = "14px";

    const actions = this.doc.createElement("div");
    actions.className = "ls-actions";
    actions.style.display = "grid";
    actions.style.gridTemplateColumns = "1fr";

    const button = this.doc.createElement("button");
    button.className = "ls-button";
    button.type = "submit";
    button.textContent = "解锁";
    button.style.height = "40px";
    button.style.border = "0";
    button.style.borderRadius = "10px";
    button.style.background = "linear-gradient(135deg, #4b77d4, #4d93ff)";
    button.style.color = "#f7faff";
    button.style.fontWeight = "600";
    button.style.cursor = "pointer";

    const error = this.doc.createElement("div");
    error.className = "ls-error";
    error.style.minHeight = "18px";
    error.style.color = "#ff8e8e";
    error.style.fontSize = "12px";

    actions.append(button);
    form.append(input, actions, error);
    panel.append(badge, title, subtitle, form);
    root.append(panel);

    form.addEventListener("submit", (event) => {
      event.preventDefault();
      void this.submitPasscode();
    });

    root.addEventListener("click", (event) => {
      if (event.target === root) {
        this.focusInput();
      }
    });

    panel.addEventListener("mousedown", (event) => {
      if (this.isInputElement(event.target)) {
        return;
      }

      setTimeout(() => {
        this.focusInput();
      }, 0);
    });

    this.doc.body.append(root);

    this.rootEl = root;
    this.inputEl = input;
    this.submitButtonEl = button;
    this.errorEl = error;

    this.startFocusGuard();

    this.win.requestAnimationFrame(() => {
      this.focusInput();
    });
  }

  hide(): void {
    if (!this.rootEl) {
      return;
    }

    this.rootEl.remove();
    this.stopFocusGuard();
    this.rootEl = null;
    this.inputEl = null;
    this.submitButtonEl = null;
    this.errorEl = null;
  }

  destroy(): void {
    this.hide();
  }

  setError(message: string): void {
    if (!this.errorEl) {
      return;
    }

    this.errorEl.textContent = message;
  }

  focusInput(): void {
    if (!this.inputEl) {
      return;
    }

    this.inputEl.focus();
    this.inputEl.select();
  }

  appendCharacter(char: string): void {
    if (!this.inputEl) {
      return;
    }

    this.inputEl.value += char;
    this.inputEl.focus();
  }

  deleteLastCharacter(): void {
    if (!this.inputEl) {
      return;
    }

    this.inputEl.value = this.inputEl.value.slice(0, -1);
    this.inputEl.focus();
  }

  private startFocusGuard(): void {
    if (!this.inputEl) {
      return;
    }

    this.stopFocusGuard();
    this.doc.addEventListener("focusin", this.focusGuardHandler, true);
    this.focusGuardTimer = this.win.setInterval(() => {
      if (!this.rootEl || !this.inputEl) {
        return;
      }

      const activeEl = this.doc.activeElement;
      if (!activeEl || !this.rootEl.contains(activeEl)) {
        this.focusInput();
      }
    }, 250);
  }

  private stopFocusGuard(): void {
    this.doc.removeEventListener("focusin", this.focusGuardHandler, true);
    if (this.focusGuardTimer !== null) {
      this.win.clearInterval(this.focusGuardTimer);
      this.focusGuardTimer = null;
    }
  }

  private getWindowControlInset(): number {
    const titlebarEl = this.doc.querySelector(".titlebar") as HTMLElement | null;
    if (!titlebarEl) {
      return 0;
    }

    const height = Math.ceil(titlebarEl.getBoundingClientRect().height);
    if (!Number.isFinite(height) || height <= 0) {
      return 0;
    }

    return Math.min(height, 80);
  }

  private isInputElement(target: EventTarget | null): target is HTMLInputElement {
    const maybeElement = target as { nodeType?: number; tagName?: string } | null;
    if (!maybeElement || maybeElement.nodeType !== 1 || typeof maybeElement.tagName !== "string") {
      return false;
    }

    return maybeElement.tagName.toLowerCase() === "input";
  }

  private async submitPasscode(): Promise<void> {
    if (!this.inputEl || !this.submitButtonEl) {
      return;
    }

    const passcode = this.inputEl.value;
    if (!passcode) {
      this.setError("请输入授权码。");
      this.focusInput();
      return;
    }

    this.submitButtonEl.disabled = true;
    this.setError("");

    try {
      const ok = await this.onSubmit(passcode);
      if (!ok) {
        this.inputEl.value = "";
        this.setError("授权码错误，请重试。");
        this.focusInput();
      }
    } finally {
      if (this.submitButtonEl) {
        this.submitButtonEl.disabled = false;
      }
    }
  }
}
