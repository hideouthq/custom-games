'use strict';

(function () {
  const root = $.GetContextPanel();
  const command = 'citadel_camera_overrides_enabled ';
  let scheduled = 0;
  let active = true;
  let inMode = false;
  let spectating = false;
  // The convar is archived, so its value at load is unknown until we write it.
  let applied = null;

  function outsideHideout() {
    let hud = root;
    while (hud && hud.id !== 'Hud') hud = hud.GetParent();
    return !!hud && hud.IsValid() && !hud.BHasClass('InHideout');
  }

  function set(enabled) {
    if (applied === enabled) return;
    $.DispatchEvent('CitadelConCommand', command + (enabled ? '1' : '0'));
    applied = enabled;
  }

  function restore() {
    if (!active) return;
    active = false;
    if (scheduled) $.CancelScheduled(scheduled);
    if (applied !== null) set(false);
  }

  // The override frames a watched hero correctly but replaces the hero's own
  // camera rig, which drops and pulls back on a crouch or slide.
  function update() {
    scheduled = 0;
    if (!active) return;
    if (!root.IsValid()) { restore(); return; }
    const inGame = outsideHideout();
    if (!inGame) {
      inMode = false;
      if (applied !== null) set(false);
    } else if (inMode) set(spectating);
    scheduled = $.Schedule(0.2, update);
  }

  Modlock.onUnload(restore);
  // Leaving or quitting mid-match does not always unload the layout, and the
  // setting is saved, so it would follow the player into every other game.
  if ($.RegisterForUnhandledEvent) {
    ['CitadelDisconnectFromGame', 'GameSystemGameShutdown'].forEach(function (event) {
      $.RegisterForUnhandledEvent(event, function () { restore(); return false; });
    });
  }
  Modlock.data(value => {
    if (!active || !root.IsValid() || !value || typeof value !== 'object' || !outsideHideout()) return;
    inMode = true;
    spectating = value.spectating === true;
    set(spectating);
  });
  update();
})();
