// IME composition gate -- a factory, NOT a module-level singleton with
// getter/setter exports like sync-controller.js/split.js.
//
// This deliberately departs from the getter/setter-singleton convention used
// elsewhere in this codebase: module-scope `let` + named exports is for
// STATE THAT IS ACTUALLY SHARED across call sites (sync-controller.js's
// document body/blocks/frontMatter, the origin tag -- genuinely one copy for
// the whole app). Composition state is the opposite: TWO independent
// instances are needed this phase, one for #md-input (editor-events.js) and
// one for #preview (preview/events.js), and they must never share state --
// composing in one pane must never gate sync in the other. A factory is
// therefore the correct choice, not merely a permitted one.
//
// Event order this gates against (03-RESEARCH.md Pattern 5, verified against
// the pinned Electron 43.4.0/Chromium 150 runtime):
//   compositionstart -> compositionupdate* -> beforeinput/input(isComposing:true)
//     -> compositionend -> input(isComposing:false)
// start()/end() are called on compositionstart/compositionend respectively.
// Note compositionend fires BEFORE the final isComposing:false input event --
// callers must resync on the NEXT input event after end(), not synchronously
// inside the compositionend handler itself.
export function createCompositionGate() {
  let composing = false;

  return {
    start() {
      composing = true;
    },
    end() {
      composing = false;
    },
    isComposing() {
      return composing;
    },
  };
}
