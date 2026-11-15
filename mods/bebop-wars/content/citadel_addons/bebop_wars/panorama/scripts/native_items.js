'use strict';
var BebopItems = (function () {
  let root = $.GetContextPanel();
  while (root.GetParent()) root = root.GetParent();
  const tooltip = Modlock.native.group();
  const bodies = new Map();
  const covers = new Map();
  let view = null, hud = null, shown = null, source = null, polling = 0;
  const nativeIconClass = { snowGlobe: 'iceBlast', sprint: 'fleetfootBoots', echo: 'powerShard', knockdown: 'bulletShield', piano: 'lastStand', shrinkRay: 'stimPak', etherealShift: 'shiftingShroud', rescueBeam: 'medicBeam' };
  const covered = { snowGlobe: true, knockdown: true, piano: true };
  const shopArt = {
    snowGlobe: 'file://{images}/{addon}/overlay/items/snow-globe_png.vtex',
    sprint: 's2r://panorama/images/items/weapon/fleetfoot_psd.vtex',
    echo: 's2r://panorama/images/items/spirit/echo_shard_psd.vtex',
    knockdown: 's2r://panorama/images/items/spirit/knockdown_psd.vtex',
    piano: 's2r://panorama/images/items/brawl/mystical_piano_psd.vtex',
    shrinkRay: 's2r://panorama/images/items/brawl/shrink_ray_psd.vtex',
    etherealShift: 's2r://panorama/images/items/spirit/ethereal_shift_psd.vtex',
    rescueBeam: 's2r://panorama/images/items/vitality/rescue_beam_psd.vtex'
  };
  function product(id) { return view.shop.products.find(function (item) { return item.id === id; }); }
  function details(container) {
    const body = tooltip.create('Panel', container, 'BebopItemDetails');
    body.AddClass('AppliedAttributesContainer'); body.AddClass('TopBottomFlow');
    const header = $.CreatePanel('Panel', body, 'BebopItemHeader'); header.AddClass('CooldownHeader');
    const heading = $.CreatePanel('Label', header, 'BebopItemActive'); heading.AddClass('ActivePassiveLabel'); heading.text = 'Active';
    const cooldown = $.CreatePanel('Panel', header, 'BebopItemCooldown'); cooldown.AddClass('CooldownContainer'); cooldown.AddClass('LeftRightFlow'); cooldown.style.visibility = 'visible'; cooldown.style.horizontalAlign = 'right';
    $.CreatePanel('Panel', cooldown, 'BebopItemClock').AddClass('CooldownImage');
    const timer = $.CreatePanel('Label', cooldown, 'BebopItemTimer'); timer.style.verticalAlign = 'center'; timer.style.fontWeight = 'bold';
    const description = $.CreatePanel('Label', body, 'BebopItemDescription'); description.AddClass('ModInfoLabel'); description.style.whiteSpace = 'normal'; description.style.margin = '10px 10px 2px 10px';
    const stats = $.CreatePanel('Panel', body, 'BebopItemStats'); stats.style.flowChildren = 'right-wrap'; stats.style.width = '100%'; stats.style.margin = '8px 6px 0px 10px';
    const footer = $.CreatePanel('Panel', body, 'BebopItemFooter'); footer.style.width = '100%'; footer.style.marginTop = '10px'; footer.style.padding = '7px 10px'; footer.style.backgroundColor = '#00000055';
    const state = $.CreatePanel('Label', footer, 'BebopItemState'); state.style.whiteSpace = 'normal'; state.style.fontSize = '16px'; state.style.fontWeight = 'bold';
    return body;
  }
  function apply() {
    if (!shown || !view) return;
    const active = product(shown.id);
    if (!active) { closed(); return; }
    root.FindChildrenWithClassTraverse('TooltipVisible').filter(function (panel) { return panel.paneltype === 'CitadelTooltipModDetails'; }).forEach(function (panel) {
      tooltip.relabel(panel.FindChildTraverse('ModName'), active.name, ['ModName']);
      panel.FindChildrenWithClassTraverse('ModCost').forEach(function (label) { tooltip.relabel(label, String(active.price), ['ModCost']); });
      tooltip.style(panel.FindChildTraverse('ModImage'), { backgroundImage: 'url("' + shopArt[active.id] + '")' });
      ['TierBonusContainer', 'SectionsContainer', 'ComponentsContainer', 'ComponentOfContainer', 'ComponentUsedContainer', 'ModImbuedContainer', 'PopularityContainer'].forEach(function (id) { tooltip.hide(panel.FindChildTraverse(id)); });
      const container = panel.FindChildrenWithClassTraverse('AttributesContainer')[0];
      if (!container) return;
      if (!bodies.has(panel)) bodies.set(panel, details(container));
      const body = bodies.get(panel);
      body.FindChildTraverse('BebopItemTimer').text = active.cooldown + 's';
      body.FindChildTraverse('BebopItemDescription').text = active.description;
      statBoxes(body.FindChildTraverse('BebopItemStats'), active.stats || []);
      const state = body.FindChildTraverse('BebopItemState');
      state.text = active.label + (active.detail ? ' · ' + active.detail : '');
      state.style.color = stateColour[active.state] || '#cdcdcd';
    });
  }
  const stateColour = { buy: '#9be3b7', equipped: '#9be3b7', owned: '#e6dcc3', pending: '#e6dcc3', unaffordable: '#ff8a7a', locked: '#b9b9b9' };
  function statBoxes(container, stats) {
    if (!container) return;
    const signature = JSON.stringify(stats);
    if (container.GetAttributeString('bebop_item_stats', '') === signature) return;
    container.SetAttributeString('bebop_item_stats', signature);
    container.RemoveAndDeleteChildren();
    stats.forEach(function (stat, index) {
      const box = $.CreatePanel('Panel', container, 'BebopItemStat' + index);
      box.style.flowChildren = 'down'; box.style.minWidth = '104px'; box.style.padding = '8px 12px'; box.style.margin = '0px 4px 4px 0px'; box.style.backgroundColor = '#00000040';
      const value = $.CreatePanel('Label', box, 'BebopItemStatValue' + index);
      value.text = stat.value; value.style.fontSize = '22px'; value.style.fontWeight = 'bold'; value.style.color = '#ffffff'; value.style.horizontalAlign = 'center';
      const name = $.CreatePanel('Label', box, 'BebopItemStatLabel' + index);
      name.text = stat.label; name.style.fontSize = '15px'; name.style.color = '#cdcdcd'; name.style.horizontalAlign = 'center';
    });
  }
  function closed() { shown = null; source = null; bodies.clear(); tooltip.release(); }
  function show(panel, item) {
    if (!view || view.native.slot < 0) return;
    const current = product(item.id);
    if (!current) return;
    closed();
    shown = current; source = panel;
    $.DispatchEvent('CitadelShowModTooltip', panel, current.nativeId, view.native.slot);
    apply();
  }
  function hide(panel, item) {
    if (source !== panel || shown.id !== item.id) return;
    $.DispatchEvent('CitadelHideModTooltip', panel, shown.nativeId, view.native.slot);
    closed();
  }
  function decorate(card, product) {
    const tier = product.tier === 2 ? 2 : 1, weapon = product.category ? product.category === 'weapon' : product.id === 'sprint';
    card.SetHasClass('ModTier1', tier === 1); card.SetHasClass('ModTier2', tier === 2);
    card.SetHasClass('isWeapon', weapon);
    card.SetHasClass('isTech', !weapon);
    // The game rounds the card of anything classed isActiveItem.
    card.SetHasClass('isActiveItem', false);
    card.SetHasClass('canAffordMod', product.state !== 'unaffordable');
    const owned = product.state === 'owned' || product.state === 'equipped';
    card.SetHasClass('owned', owned);
    const purchased = card.FindChildTraverse('ItemPurchased');
    const message = purchased && purchased.FindChildrenWithClassTraverse('MessageContent')[0];
    if (message && message.GetChildCount()) message.GetChild(0).text = product.state === 'equipped' ? 'Equipped' : 'Owned';
    card.SetDialogVariable('mod_name', product.name); card.SetDialogVariableInt('item_cost', product.price);
    card.FindChildrenWithClassTraverse('modName').forEach(function (label) { label.text = product.name; label.style.visibility = 'visible'; });
    const image = card.FindChildTraverse('ModIconImage');
    if (image) { image.SetImage(shopArt[product.id]); image.style.visibility = 'visible'; }
    const price = card.FindChildTraverse('ItemCost'); if (price) price.text = String(product.price);
    const cost = card.FindChildTraverse('ItemCostContainer'); if (cost) cost.style.visibility = 'collapse';
    card.hittest = false; card.hittestchildren = false;
  }
  // A native image has no getter for its source, so custom art goes on an owned sibling drawn just above it.
  function dress(icon, image, art) {
    Modlock.native.style(icon, { tooltipPosition: 'top right left bottom' });
    if (!image || !art) return;
    let cover = covers.get(image);
    if (!cover || !cover.IsValid()) {
      cover = Modlock.native.create('Image', image.GetParent(), 'BebopItemArt', { after: image });
      cover.style.width = '100%'; cover.style.height = '100%';
      covers.set(image, cover);
    }
    cover.SetImage(art);
    Modlock.native.style(image, { opacity: '0' });
  }
  function inventory() {
    if (!view || !hud) return [];
    const anchors = [];
    const activeItems = hud.FindChildTraverse('ActiveAbilitiesMenu');
    const grids = ['ModPurchasedPanelUniversal', 'ModPurchasedPanelUniversalLocked'].map(function (id) { return hud.FindChildTraverse(id); }).filter(function (panel) { return !!panel; });
    view.native.items.forEach(function (item) {
      const owned = product(item.product);
      if (!owned) return;
      const slot = activeItems && activeItems.FindChildTraverse('abilityButton' + (item.slot - 4));
      if (slot) {
        dress(slot, slot.FindChildTraverse('ability_image'), shopArt[owned.id]);
        slot.FindChildrenWithClassTraverse('ability_name').forEach(function (label) { Modlock.native.relabel(label, owned.name, ['ability_name']); });
        anchors.push({ icon: slot, product: owned });
      }
      grids.forEach(function (grid) {
        (nativeIconClass[item.product] ? grid.FindChildrenWithClassTraverse(nativeIconClass[item.product]) : []).forEach(function (panel) {
          let icon = panel;
          while (icon && icon !== grid && icon.paneltype !== 'CitadelModIcon') icon = icon.GetParent();
          if (!icon || icon === grid) return;
          dress(icon, icon.FindChildTraverse('ModIconImage'), covered[owned.id] ? shopArt[owned.id] : null);
          anchors.push({ icon: icon, product: owned });
        });
      });
    });
    return anchors;
  }
  function hovered(panel) {
    if (panel.BHasHoverStyle()) return true;
    for (let i = 0; i < panel.GetChildCount(); i++) if (hovered(panel.GetChild(i))) return true;
    return false;
  }
  // Native icons are polled for hover: binding their events would replace handlers nothing can restore.
  function poll() {
    const anchors = inventory();
    const hit = anchors.find(function (anchor) { return hovered(anchor.icon); });
    if (hit && (hit.icon !== source || hit.product.id !== shown.id)) show(hit.icon, hit.product);
    else if (!hit && anchors.some(function (anchor) { return anchor.icon === source; })) hide(source, shown);
    apply();
    polling = $.Schedule(0.1, poll);
  }
  function update(data, panel) {
    view = data; hud = panel;
    apply();
  }
  Modlock.onUnload(function () {
    $.CancelScheduled(polling);
    if (source) hide(source, shown);
  });
  poll();
  return { update: update, decorate: decorate, show: show, hide: hide };
})();
