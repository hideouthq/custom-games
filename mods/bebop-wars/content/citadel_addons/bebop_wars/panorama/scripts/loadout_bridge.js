'use strict';
(function () {
  let hud = $.GetContextPanel();
  while (hud && hud.paneltype !== 'CitadelHud') hud = hud.GetParent();
  let shop = null, catalog = null, view = null, wasOpen = false, closing = false, observing = 0;
  function closeNative() {
    if (shop && shop.IsValid() && shop.BHasClass('gShopOpen') && !closing) {
      closing = true; $.DispatchEvent('CitadelExitUpgradeShop');
    }
  }
  const ink = '#1b241d', short = '#b3372f', quiet = '#4b5148';
  const sections = { setup: 'Setup Tool', utility: 'Utility', defense: 'Defense' };
  function paint(panel, styles) { Object.keys(styles).forEach(function (key) { panel.style[key] = styles[key]; }); return panel; }
  function label(parent, id, text, styles) {
    const panel = $.CreatePanel('Label', parent, id);
    panel.text = text; panel.hittest = false;
    return paint(panel, styles);
  }
  function note(cell, product) {
    const status = cell.FindChildTraverse('BebopStatus_' + product.id);
    if (!status) return;
    status.text = product.state === 'owned' && product.action ? String(product.label || '').toUpperCase() : '';
    status.style.visibility = status.text ? 'visible' : 'collapse';
  }
  function render() {
    if (!catalog || !catalog.IsValid() || !view) return;
    const access = catalog.FindChildTraverse('BebopShopAccess');
    access.text = view.shop.allowed ? 'Purchases last this match.' : view.shop.reason;
    access.style.color = view.shop.allowed ? quiet : short;
    view.shop.products.forEach(function (product) {
      const cell = catalog.FindChildTraverse('BebopBuy_' + product.id);
      if (!cell) return;
      const card = cell.FindChildTraverse('BebopProduct_' + product.id);
      BebopItems.decorate(card, product);
      note(cell, product);
      cell.SetPanelEvent('onactivate', function () {
        if (!product.action) return true;
        const action = product.action;
        $.DispatchEvent('CitadelConCommand', action.kind === 'buy' ? 'bebop_buy ' + action.product : 'bebop_equip ' + action.utility);
        return true;
      });
      cell.SetPanelEvent('onmouseover', function () { BebopItems.show(card, product); });
      cell.SetPanelEvent('onmouseout', function () { BebopItems.hide(card, product); });
    });
    BebopItems.update(view, hud);
  }
  function section(parent, group, products) {
    const box = paint($.CreatePanel('Panel', parent, 'BebopSection_' + group), { flowChildren: 'down', marginRight: '22px', marginBottom: '18px', border: '1px solid #3f352640', backgroundColor: '#3f35260d' });
    const bar = paint($.CreatePanel('Panel', box, 'BebopSectionBar_' + group), { width: '100%', height: '40px', backgroundColor: '#3f352666', padding: '0px 20px' });
    label(bar, 'BebopSectionName_' + group, sections[group] || 'Equipment', { fontSize: '22px', fontWeight: 'bold', color: '#efe6d0', verticalAlign: 'center', textShadow: '0px 1px 2px 1.5 #00000055' });
    const row = paint($.CreatePanel('Panel', box, 'BebopSectionRow_' + group), { flowChildren: 'right', minWidth: '620px', padding: '10px 26px 12px 12px' });
    products.forEach(function (product) {
      const cell = paint($.CreatePanel('Button', row, 'BebopBuy_' + product.id), { flowChildren: 'down', marginRight: '6px' });
      const card = $.CreatePanel('CitadelShopMod', cell, 'BebopProduct_' + product.id);
      // ui-scale enlarges the stock card through layout, so its art and text stay sharp.
      card.style.uiScale = '150%'; card.style.horizontalAlign = 'center';
      label(cell, 'BebopStatus_' + product.id, '', { fontSize: '13px', fontWeight: 'bold', letterSpacing: '1px', horizontalAlign: 'center', textAlign: 'center', color: ink, height: '18px', marginTop: '4px' });
    });
  }
  function mount() {
    if (!view || !hud) return;
    shop = hud.FindChildTraverse('CitadelHudHeroShop');
    const shell = shop && shop.FindChildTraverse('ShopModListsContainer');
    if (!shell || catalog) return;
    for (let i = 0; i < shell.GetChildCount(); i++) Modlock.native.hide(shell.GetChild(i));
    ['ShopNavigation', 'ReadOnlyShop', 'PriceTierShortcuts', 'RecentPurchasesPanel', 'ShopSettingsButton'].forEach(function (id) { Modlock.native.hide(shop.FindChildTraverse(id)); });
    Modlock.native.hide(hud.FindChildTraverse('CitadelHudQuickbuy'));
    catalog = Modlock.native.create('Panel', shell, 'BebopNativeCatalog');
    paint(catalog, { flowChildren: 'down', width: '100%', padding: '40px 56px' });
    const heading = paint($.CreatePanel('Panel', catalog, 'BebopShopHeading'), { flowChildren: 'right', width: '100%', marginBottom: '18px' });
    label(heading, 'BebopShopTitle', 'BEBOP WARS', { fontSize: '40px', fontWeight: 'black', letterSpacing: '2px', color: ink, verticalAlign: 'bottom' });
    label(heading, 'BebopShopAccess', '', { fontSize: '18px', color: quiet, verticalAlign: 'bottom', marginLeft: '20px', marginBottom: '7px' });
    const products = paint($.CreatePanel('Panel', catalog, 'BebopShopProducts'), { flowChildren: 'down', width: '100%' });
    const groups = [];
    view.shop.products.forEach(function (product) {
      const group = product.group || 'equipment';
      let entry = groups.find(function (item) { return item.group === group; });
      if (!entry) { entry = { group: group, products: [] }; groups.push(entry); }
      entry.products.push(product);
    });
    groups.forEach(function (entry) { section(products, entry.group, entry.products); });
    render();
    [0, 0.1, 0.3].forEach(function (delay) { $.Schedule(delay, render); });
  }
  Modlock.data(function (data) {
    const previous = view;
    view = data;
    if (!view) return;
    if (!view.canShop || (previous && previous.menu === 'loadout' && view.menu === 'closed')) closeNative();
    mount(); render();
    BebopItems.update(view, hud);
  });
  function observe() {
    if (!catalog) mount();
    if (shop && shop.IsValid()) {
      const open = shop.BHasClass('gShopOpen');
      if (open && !wasOpen) {
        $.DispatchEvent('CitadelConCommand', 'loadout');
        render(); [0, 0.1].forEach(function (delay) { $.Schedule(delay, render); });
        if (!view || !view.canShop) closeNative();
      } else if (!open && wasOpen) {
        if (!closing) $.DispatchEvent('CitadelConCommand', 'loadout close');
        closing = false;
      }
      wasOpen = open;
    }
    observing = $.Schedule(0.1, observe);
  }
  Modlock.onUnload(function () { $.CancelScheduled(observing); });
  observe();
})();
