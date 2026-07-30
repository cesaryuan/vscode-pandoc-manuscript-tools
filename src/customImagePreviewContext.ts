import { HAS_CUSTOM_IMAGE_PREVIEW_CONTEXT } from "./constants";

/** Manages VS Code's opt-in guard for extensions that provide an SVG preview. */
export class CustomImagePreviewContext {
  /**
   * Creates the lifecycle manager with the host-specific context setter.
   *
   * Keeping the setter injectable lets the lifecycle contract be tested without a VS Code host.
   *
   * @param setContext Updates a VS Code context key.
   */
  constructor(private readonly setContext: (key: string, value: boolean) => void) {}

  /** Enables hiding VS Code's duplicate SVG preview action. */
  enable(): void {
    this.setContext(HAS_CUSTOM_IMAGE_PREVIEW_CONTEXT, true);
  }

  /** Restores the built-in SVG preview action when this extension is disposed. */
  dispose(): void {
    this.setContext(HAS_CUSTOM_IMAGE_PREVIEW_CONTEXT, false);
  }
}
