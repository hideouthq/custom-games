'use strict';

// Flying the player's camera makes the game draw its roaming spectator controls.
(function () {
  const root = $.GetContextPanel();
  let sweeping = 0;

  function sweep() {
    let top = root;
    while (top.GetParent()) top = top.GetParent();
    Modlock.native.style(top.FindChildTraverse('spectate_container'), { visibility: 'collapse', opacity: '0' });
    sweeping = $.Schedule(0.1, sweep);
  }

  Modlock.onUnload(() => $.CancelScheduled(sweeping));
  sweep();
})();
