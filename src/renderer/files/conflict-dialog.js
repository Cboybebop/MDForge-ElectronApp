// SAVE CONFLICT DIALOG — first real modal UI in the app (SHELL-03/04).
//
// 04-CONTEXT.md "Atomic Write & Failure Semantics": a save-time mtime/size
// mismatch must escalate to the user with three named choices -- Keep Mine /
// Reload Theirs / Save As Copy -- defaulting to the non-destructive option.
// Every existing "ask the user" path in this codebase is a bare
// window.confirm() (two choices only, open.js/new.js's dirty-check gate) or
// a transient showStatus() toast (status.js) -- neither is extensible to
// three named choices, so this is built from scratch as a native <dialog>
// element rather than forced into confirm(). 04-PATTERNS.md names this file
// explicitly as having no analog.
//
// Lazily created on first call and reused thereafter (never a second
// <dialog> stacked in the DOM), matching the "guard against duplicate
// creation" requirement in the plan's acceptance criteria.

let dialogEl = null;

function createDialog() {
  const dialog = document.createElement('dialog');
  dialog.className = 'conflict-dialog';

  const message = document.createElement('p');
  message.textContent = 'This file changed on disk since you opened it.';
  dialog.appendChild(message);

  const actions = document.createElement('div');
  actions.className = 'conflict-dialog-actions';

  const btnKeepMine = document.createElement('button');
  btnKeepMine.type = 'button';
  btnKeepMine.textContent = 'Keep Mine';
  actions.appendChild(btnKeepMine);

  const btnReloadTheirs = document.createElement('button');
  btnReloadTheirs.type = 'button';
  btnReloadTheirs.textContent = 'Reload Theirs';
  // Non-destructive default (04-CONTEXT.md: "defaulting to the
  // non-destructive option") -- carries autofocus so Enter activates it.
  btnReloadTheirs.autofocus = true;
  actions.appendChild(btnReloadTheirs);

  const btnSaveAsCopy = document.createElement('button');
  btnSaveAsCopy.type = 'button';
  btnSaveAsCopy.textContent = 'Save As Copy';
  actions.appendChild(btnSaveAsCopy);

  dialog.appendChild(actions);
  document.body.appendChild(dialog);

  return { dialog, btnKeepMine, btnReloadTheirs, btnSaveAsCopy };
}

/**
 * Shows the Keep Mine / Reload Theirs / Save As Copy conflict dialog and
 * resolves with the string literal of the choice the user activated.
 * Reuses a single lazily-created <dialog> element across calls; closes it
 * immediately before resolving so a second call never stacks a duplicate.
 */
export function showConflictDialog() {
  if (!dialogEl) {
    dialogEl = createDialog();
  }
  const { dialog, btnKeepMine, btnReloadTheirs, btnSaveAsCopy } = dialogEl;

  return new Promise((resolve) => {
    function choose(choice) {
      btnKeepMine.removeEventListener('click', onKeepMine);
      btnReloadTheirs.removeEventListener('click', onReloadTheirs);
      btnSaveAsCopy.removeEventListener('click', onSaveAsCopy);
      dialog.close();
      resolve(choice);
    }

    function onKeepMine() { choose('keep-mine'); }
    function onReloadTheirs() { choose('reload-theirs'); }
    function onSaveAsCopy() { choose('save-as-copy'); }

    btnKeepMine.addEventListener('click', onKeepMine);
    btnReloadTheirs.addEventListener('click', onReloadTheirs);
    btnSaveAsCopy.addEventListener('click', onSaveAsCopy);

    dialog.showModal();
  });
}
