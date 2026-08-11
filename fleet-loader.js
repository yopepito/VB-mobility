(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory();
  } else {
    root.FleetLoader = factory();
  }
})(typeof window !== 'undefined' ? window : globalThis, function () {

  // ---- EDIT ME: paste your published Google Sheet CSV link here (see FLEET_ADMIN.md) ----
  var SHEET_CSV_URL = "PASTE_YOUR_PUBLISHED_GOOGLE_SHEET_CSV_LINK_HERE";

  // ---- EDIT ME: the real WhatsApp number, international format, no + and no spaces ----
  var WA_NUMBER = "41000000000";

  function parseCSV(csvText) {
    var rows = [];
    var row = [];
    var field = '';
    var inQuotes = false;
    var i = 0;
    var text = String(csvText || '');

    function endField() { row.push(field); field = ''; }
    function endRow() { endField(); rows.push(row); row = []; }

    while (i < text.length) {
      var c = text[i];
      if (inQuotes) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
          inQuotes = false; i++; continue;
        }
        field += c; i++; continue;
      }
      if (c === '"') { inQuotes = true; i++; continue; }
      if (c === ',') { endField(); i++; continue; }
      if (c === '\r') { i++; continue; }
      if (c === '\n') { endRow(); i++; continue; }
      field += c; i++;
    }
    if (field.length > 0 || row.length > 0) { endRow(); }

    rows = rows.filter(function (r) { return !(r.length === 1 && r[0].trim() === ''); });
    if (rows.length === 0) { return []; }

    var header = rows[0].map(function (h) { return h.trim(); });
    return rows.slice(1).map(function (r) {
      var obj = {};
      header.forEach(function (key, idx) {
        obj[key] = (r[idx] !== undefined ? r[idx] : '').trim();
      });
      return obj;
    });
  }

  function toIntOrNull(value) {
    var n = parseInt(String(value).trim(), 10);
    return (String(value).trim() !== '' && !isNaN(n)) ? n : null;
  }

  // Google Sheets exports a date cell differently depending on the sheet's locale
  // (a Swiss sheet gives 12.08.2026, an ISO-formatted one gives 2026-08-12). Accept
  // every plausible form rather than making the owner remember one.
  function parseSheetDate(value) {
    var s = String(value == null ? '' : value).trim();
    if (!s) { return null; }

    var y, m, d;
    var iso = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (iso) {
      y = +iso[1]; m = +iso[2]; d = +iso[3];
    } else {
      var eu = s.match(/^(\d{1,2})[./](\d{1,2})[./](\d{4})$/);
      if (!eu) { return null; }
      d = +eu[1]; m = +eu[2]; y = +eu[3];
    }

    var date = new Date(y, m - 1, d);
    // Rejects impossible dates like 32.13.2026, which JS would otherwise roll over.
    if (date.getFullYear() !== y || date.getMonth() !== m - 1 || date.getDate() !== d) { return null; }
    return date;
  }

  // <input type="date"> only understands yyyy-mm-dd, whatever the visitor's locale.
  function isoDate(date) {
    if (!date) { return ''; }
    var m = String(date.getMonth() + 1);
    var d = String(date.getDate());
    if (m.length < 2) { m = '0' + m; }
    if (d.length < 2) { d = '0' + d; }
    return date.getFullYear() + '-' + m + '-' + d;
  }

  function formatSheetDate(date) {
    if (!date) { return ''; }
    var d = String(date.getDate());
    var m = String(date.getMonth() + 1);
    if (d.length < 2) { d = '0' + d; }
    if (m.length < 2) { m = '0' + m; }
    return d + '.' + m + '.' + date.getFullYear();
  }

  // A date in the past means the rental already ended, so the vehicle is free again.
  // That way a cell the owner forgot to clear never strands a vehicle as "taken".
  function availabilityOf(v, now) {
    now = now || new Date();
    var from = v && v.libreDes;
    if (!from) { return { free: true, from: null }; }
    var today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    if (from.getTime() <= today.getTime()) { return { free: true, from: null }; }
    return { free: false, from: from };
  }

  function normalizeVehicle(row) {
    row = row || {};
    var id = String(row.id || '').trim();
    var nom = String(row.nom || '').trim();
    if (!id || !nom) { return null; }

    var statutRaw = String(row.statut || '').trim().toLowerCase();
    var statut = (statutRaw === 'disponible') ? 'disponible' : 'bientot';

    var categorieRaw = String(row.categorie || '').trim().toLowerCase();
    var categorie = ['hybride', 'electrique', 'essence'].indexOf(categorieRaw) !== -1 ? categorieRaw : 'essence';

    return {
      id: id,
      nom: nom,
      statut: statut,
      categorie: categorie,
      prixSemaineChf: toIntOrNull(row.prix_semaine_chf),
      consommationL100: String(row.consommation_l100 || '').trim() || null,
      places: toIntOrNull(row.places),
      boite: String(row.boite || '').trim().toLowerCase(),
      annee: toIntOrNull(row.annee),
      disponibiliteNote: String(row.disponibilite_note || '').trim(),
      libreDes: parseSheetDate(row.libre_des),
      ordre: toIntOrNull(row.ordre) || 0
    };
  }

  function computeHeadlinePrice(vehicles) {
    var prices = (vehicles || [])
      .filter(function (v) { return v.statut === 'disponible' && v.prixSemaineChf != null; })
      .map(function (v) { return v.prixSemaineChf; });
    if (prices.length === 0) { return null; }
    return Math.min.apply(null, prices);
  }

  function pickLabel(dict, key) {
    if (dict && Object.prototype.hasOwnProperty.call(dict, key)) { return dict[key]; }
    return key;
  }

  var FALLBACK_VEHICLES = [
    { id: 'auris-1', nom: 'Toyota Auris', statut: 'disponible', categorie: 'hybride',
      prixSemaineChf: 250, consommationL100: '4.2', places: 5,
      boite: 'automatique', annee: 2017,
      disponibiliteNote: 'VD · VTC', libreDes: null, ordre: 1 },
    { id: 'berline-soon', nom: 'Berline hybride', statut: 'bientot', categorie: 'hybride',
      prixSemaineChf: null, consommationL100: '~4.5', places: 5,
      boite: 'automatique', annee: null,
      disponibiliteNote: '2026-27', libreDes: null, ordre: 2 },
    { id: 'electrique-soon', nom: '100% électrique', statut: 'bientot', categorie: 'electrique',
      prixSemaineChf: null, consommationL100: null, places: 5,
      boite: 'automatique', annee: null,
      disponibiliteNote: 'Anticipe 2030', libreDes: null, ordre: 3 }
  ];

  var LABELS = {
    fr: {
      statut: { disponible: "Disponible", bientot: "Bientôt" },
      categorie: { hybride: "HYBRIDE", electrique: "ÉLECTRIQUE", essence: "ESSENCE" },
      energieParCategorie: { hybride: "Essence + élec.", electrique: "100 % élec.", essence: "Essence" },
      consommationLabel: "Consommation",
      energieLabel: "Énergie",
      placesLabel: "Places",
      boiteLabel: "Boîte",
      anneeLabel: "Année",
      boite: { automatique: "Automatique", manuelle: "Manuelle" },
      statutLabel: "Statut",
      statutValue: "Autorisé VTC",
      dispoLabel: "Dispo.",
      perSemaineLabel: "CHF / semaine",
      surDemandeLabel: "Nous consulter",
      etreInformeLabel: "Être informé",
      libreLabel: "Libre maintenant",
      libreDesLabel: "Libre dès le {date}",
      duLabel: "Du",
      auLabel: "Au",
      demanderLabel: "Demander ces dates",
      waMessage: "Bonjour, je souhaite louer la {vehicule} ({prix} CHF/semaine) du {du} au {au}. Merci de me confirmer la disponibilité.",
      waMessageDepuis: "Bonjour, je souhaite louer la {vehicule} ({prix} CHF/semaine) à partir du {du}. Merci de me confirmer la disponibilité.",
      waMessageJusqua: "Bonjour, je souhaite louer la {vehicule} ({prix} CHF/semaine) jusqu'au {au}. Merci de me confirmer la disponibilité.",
      waMessageSansDates: "Bonjour, je suis intéressé par la {vehicule} ({prix} CHF/semaine). Quelles sont les disponibilités ?"
    },
    en: {
      statut: { disponible: "Available", bientot: "Coming soon" },
      categorie: { hybride: "HYBRID", electrique: "ELECTRIC", essence: "PETROL" },
      energieParCategorie: { hybride: "Petrol + electric", electrique: "100% electric", essence: "Petrol" },
      consommationLabel: "Consumption",
      energieLabel: "Fuel",
      placesLabel: "Seats",
      boiteLabel: "Gearbox",
      anneeLabel: "Year",
      boite: { automatique: "Automatic", manuelle: "Manual" },
      statutLabel: "Status",
      statutValue: "VTC licensed",
      dispoLabel: "Available",
      perSemaineLabel: "CHF / week",
      surDemandeLabel: "Contact us",
      etreInformeLabel: "Get notified",
      libreLabel: "Available now",
      libreDesLabel: "Available from {date}",
      duLabel: "From",
      auLabel: "To",
      demanderLabel: "Request these dates",
      waMessage: "Hello, I would like to rent the {vehicule} ({prix} CHF/week) from {du} to {au}. Could you confirm availability?",
      waMessageDepuis: "Hello, I would like to rent the {vehicule} ({prix} CHF/week) from {du} onwards. Could you confirm availability?",
      waMessageJusqua: "Hello, I would like to rent the {vehicule} ({prix} CHF/week) until {au}. Could you confirm availability?",
      waMessageSansDates: "Hello, I'm interested in the {vehicule} ({prix} CHF/week). What is the availability?"
    },
    de: {
      statut: { disponible: "Verfügbar", bientot: "Bald verfügbar" },
      categorie: { hybride: "HYBRID", electrique: "ELEKTRISCH", essence: "BENZIN" },
      energieParCategorie: { hybride: "Benzin + Elektro", electrique: "100 % elektrisch", essence: "Benzin" },
      consommationLabel: "Verbrauch",
      energieLabel: "Antrieb",
      placesLabel: "Sitzplätze",
      boiteLabel: "Getriebe",
      anneeLabel: "Baujahr",
      boite: { automatique: "Automat", manuelle: "Handschaltung" },
      statutLabel: "Status",
      statutValue: "VTC-zugelassen",
      dispoLabel: "Verfügbar",
      perSemaineLabel: "CHF / Woche",
      surDemandeLabel: "Auf Anfrage",
      etreInformeLabel: "Benachrichtigen lassen",
      libreLabel: "Jetzt verfügbar",
      libreDesLabel: "Verfügbar ab {date}",
      duLabel: "Von",
      auLabel: "Bis",
      demanderLabel: "Diese Daten anfragen",
      waMessage: "Guten Tag, ich möchte den {vehicule} ({prix} CHF/Woche) vom {du} bis zum {au} mieten. Können Sie die Verfügbarkeit bestätigen?",
      waMessageDepuis: "Guten Tag, ich möchte den {vehicule} ({prix} CHF/Woche) ab dem {du} mieten. Können Sie die Verfügbarkeit bestätigen?",
      waMessageJusqua: "Guten Tag, ich möchte den {vehicule} ({prix} CHF/Woche) bis zum {au} mieten. Können Sie die Verfügbarkeit bestätigen?",
      waMessageSansDates: "Guten Tag, ich interessiere mich für den {vehicule} ({prix} CHF/Woche). Wie ist die Verfügbarkeit?"
    }
  };

  var CAR_ICON_SVG =
    '<svg class="vcar" viewBox="0 0 320 130" fill="none" aria-hidden="true">' +
    '<path d="M30 88 C46 60 66 50 96 47 C120 45 168 45 196 47 C224 49 258 56 284 74 C296 82 300 86 300 88" ' +
    'stroke="currentColor" stroke-width="3" stroke-linejoin="round" fill="color-mix(in srgb,currentColor 7%,transparent)"/>' +
    '<path d="M24 88 H300" stroke="currentColor" stroke-width="3" stroke-linecap="round"/>' +
    '<circle cx="92" cy="96" r="17" fill="none" stroke="currentColor" stroke-width="3"/>' +
    '<circle cx="92" cy="96" r="6" fill="var(--surface)" stroke="currentColor" stroke-width="2"/>' +
    '<circle cx="238" cy="96" r="17" fill="none" stroke="currentColor" stroke-width="3"/>' +
    '<circle cx="238" cy="96" r="6" fill="var(--surface)" stroke="currentColor" stroke-width="2"/>' +
    '</svg>';

  // Per-spec icons. Keep viewBox/stroke attrs in sync with the ".spec svg" CSS
  // rule in the HTML files (size/color rules there assume this exact markup).
  var GAUGE_ICON_SVG =
    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' +
    '<path d="M3 12a9 9 0 1 1 18 0"/><path d="M12 12l4-3"/></svg>';

  var BATTERY_ICON_SVG =
    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' +
    '<rect x="3" y="7" width="14" height="10" rx="2"/><path d="M17 10h3v4h-3"/></svg>';

  var BOLT_ICON_SVG =
    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' +
    '<path d="M13 3l-6 9h4l-2 9 8-11h-5z"/></svg>';

  var SEAT_ICON_SVG =
    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' +
    '<path d="M12 3v18M5 8l7-5 7 5"/></svg>';

  var SHIELD_ICON_SVG =
    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' +
    '<path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6z"/></svg>';

  var CLOCK_ICON_SVG =
    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' +
    '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>';

  var GEARBOX_ICON_SVG =
    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' +
    '<path d="M6 4v16M12 4v16M18 4v10"/><path d="M6 9h12"/></svg>';

  var CALENDAR_ICON_SVG =
    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' +
    '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/></svg>';

  function escapeHTML(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function energyLabelFor(categorie, labels) {
    var map = (labels && labels.energieParCategorie) || {};
    return pickLabel(map, categorie);
  }

  function fillTemplate(template, values) {
    return String(template || '').replace(/\{(\w+)\}/g, function (whole, key) {
      return Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : whole;
    });
  }

  // Traduit ce que le chauffeur a saisi en deux dates affichables. Sort du
  // gestionnaire de clic pour etre testable : c'est ici que se decide si une
  // plage est envoyee telle quelle, amputee, ou laissee ouverte.
  // Une fin anterieure au debut est ecartee plutot que transmise : l'exploitant
  // recoit "a partir du ..." et non une plage absurde a demeler.
  function resolveRequestedDates(fromValue, toValue) {
    var dFrom = parseSheetDate(fromValue);
    var dTo = parseSheetDate(toValue);
    if (dFrom && dTo && dTo.getTime() < dFrom.getTime()) { dTo = null; }
    return { du: formatSheetDate(dFrom), au: formatSheetDate(dTo) };
  }

  // The driver picks dates on the card; the message is assembled at click time and
  // handed to WhatsApp. Nothing is booked automatically — VB Mobility confirms by hand.
  function bookingMessageFor(v, labels, du, au) {
    var values = {
      vehicule: v.nom,
      prix: v.prixSemaineChf != null ? v.prixSemaineChf : '',
      du: du,
      au: au
    };
    // Quatre cas, pas deux : une date seule doit survivre. L'ancienne version
    // retombait sur le message sans dates des qu'il en manquait une, et la date
    // que le chauffeur venait de saisir disparaissait sans que personne le voie.
    var template;
    if (du && au) { template = labels.waMessage; }
    else if (du)  { template = labels.waMessageDepuis; }
    else if (au)  { template = labels.waMessageJusqua; }
    else          { template = labels.waMessageSansDates; }
    return fillTemplate(template, values);
  }

  function vehicleCardHTML(v, labels, now) {
    var isAvailable = v.statut === 'disponible';
    var availability = availabilityOf(v, now);
    var plate = isAvailable ? escapeHTML(v.disponibiliteNote || '') : '— · —';
    var tagClass = isAvailable ? 'dispo' : 'soon-t';
    var tagText = pickLabel(labels.statut, v.statut);
    var catText = pickLabel(labels.categorie, v.categorie);
    var consoText = v.consommationL100 ? (escapeHTML(v.consommationL100) + ' L/100') : '—';
    var energyText = energyLabelFor(v.categorie, labels);
    var energyIconHTML = v.categorie === 'electrique' ? BOLT_ICON_SVG : BATTERY_ICON_SVG;
    var placesText = v.places != null ? escapeHTML(v.places) : '—';
    var fourthLabel = isAvailable ? labels.statutLabel : labels.dispoLabel;
    var fourthValue = isAvailable ? labels.statutValue : escapeHTML(v.disponibiliteNote || '—');
    var fourthIconHTML = isAvailable ? SHIELD_ICON_SVG : CLOCK_ICON_SVG;
    var priceHTML = v.prixSemaineChf != null
      ? '<span class="amt">' + escapeHTML(v.prixSemaineChf) + '<small>.–</small></span><div class="per">' + labels.perSemaineLabel + '</div>'
      : '<span class="amt" style="color:var(--muted)">—</span><div class="per">' + labels.surDemandeLabel + '</div>';
    var ctaHTML = isAvailable
      ? '<button type="button" class="btn btn-outline js-ask">' + labels.demanderLabel + '</button>'
      : '<a class="btn btn-outline" href="#contact">' + labels.etreInformeLabel + '</a>';

    // Availability strip + date pickers, only on vehicles that can actually be rented.
    var availabilityHTML = '';
    if (isAvailable) {
      var freeText = availability.free
        ? labels.libreLabel
        : fillTemplate(labels.libreDesLabel, { date: formatSheetDate(availability.from) });
      // Nobody can ask for dates before the car is back. data-min-initial garde ce
      // plancher de depart : quand le chauffeur efface "Du", "Au" y revient au lieu
      // de retomber a une date libre.
      var minDate = isoDate(availability.free ? (now || new Date()) : availability.from);
      var minAttr = ' min="' + minDate + '"';
      availabilityHTML =
        '<div class="avail">' +
        '<div class="avail-state' + (availability.free ? ' is-free' : '') + '">' + CLOCK_ICON_SVG + '<span>' + escapeHTML(freeText) + '</span></div>' +
        '<div class="avail-dates">' +
        '<label><span>' + labels.duLabel + '</span><input type="date" class="js-from"' + minAttr + '></label>' +
        '<label><span>' + labels.auLabel + '</span><input type="date" class="js-to"' + minAttr + ' data-min-initial="' + minDate + '"></label>' +
        '</div>' +
        '</div>';
    }

    // Une ligne n'apparait que si la donnee existe : une fiche incomplete dans le
    // Sheet produit une carte plus courte, jamais une ligne vide ou un "—" de trop.
    function spec(icon, key, val) {
      return '<div class="spec">' + icon + '<div><span class="k">' + key + '</span><span class="v">' + val + '</span></div></div>';
    }
    var specs = [];
    if (v.consommationL100) { specs.push(spec(GAUGE_ICON_SVG, labels.consommationLabel, consoText)); }
    specs.push(spec(energyIconHTML, labels.energieLabel, energyText));
    if (v.boite) { specs.push(spec(GEARBOX_ICON_SVG, labels.boiteLabel, escapeHTML(pickLabel(labels.boite, v.boite)))); }
    if (v.places != null) { specs.push(spec(SEAT_ICON_SVG, labels.placesLabel, placesText)); }
    if (v.annee != null) { specs.push(spec(CALENDAR_ICON_SVG, labels.anneeLabel, escapeHTML(v.annee))); }
    specs.push(spec(fourthIconHTML, fourthLabel, fourthValue));
    var specsHTML = specs.join('');

    return (
      '<article class="vcard' + (isAvailable ? '' : ' soon') + '"' +
      ' data-nom="' + escapeHTML(v.nom) + '"' +
      ' data-prix="' + escapeHTML(v.prixSemaineChf != null ? v.prixSemaineChf : '') + '">' +
      '<div class="vstage">' +
      '<span class="plate">' + plate + '</span>' +
      '<span class="tag ' + tagClass + '">' + tagText + '</span>' +
      CAR_ICON_SVG +
      '</div>' +
      '<div class="vbody">' +
      '<div class="vhead"><h3>' + escapeHTML(v.nom) + '</h3><span class="cat">' + catText + '</span></div>' +
      '<div class="specs">' + specsHTML + '</div>' +
      availabilityHTML +
      '<div class="price-row"><div class="price">' + priceHTML + '</div>' + ctaHTML + '</div>' +
      '</div>' +
      '</article>'
    );
  }

  function renderFleetGrid(container, vehicles, labels) {
    if (!container) { return; }
    var sorted = (vehicles || []).slice().sort(function (a, b) { return a.ordre - b.ordre; });
    container.innerHTML = sorted.map(function (v) { return vehicleCardHTML(v, labels); }).join('');
  }

  // One delegated listener on the grid, so it survives every re-render (fallback first,
  // then the Sheet) without ever being bound twice.
  function bindBookingRequests(container, labels) {
    if (!container || container.getAttribute('data-booking-bound') === '1') { return; }
    container.setAttribute('data-booking-bound', '1');

    // Empeche une plage inversee d'etre envoyee : des que "Du" change, "Au" ne
    // peut plus descendre en dessous. Sans ca, "du 20.08 au 05.08" partait tel
    // quel et c'est l'exploitant qui devait demeler la demande a la main.
    container.addEventListener('change', function (event) {
      var el = event.target;
      if (!el.classList) { return; }
      var isFrom = el.classList.contains('js-from');
      var isTo = el.classList.contains('js-to');
      if (!isFrom && !isTo) { return; }

      var card = el.closest('.vcard');
      if (!card) { return; }
      var from = card.querySelector('.js-from');
      var to = card.querySelector('.js-to');
      if (!from || !to) { return; }

      // Le plancher de "Au" suit "Du", et revient a la date de disponibilite
      // quand "Du" est efface.
      to.min = from.value || to.getAttribute('data-min-initial') || '';

      // Une fin anterieure au debut est effacee, quel que soit le champ modifie.
      // Le chauffeur voit le champ se vider : c'est un retour visible, pas un
      // rejet silencieux au moment de l'envoi.
      if (from.value && to.value && to.value < from.value) { to.value = ''; }
    });

    container.addEventListener('click', function (event) {
      var button = event.target && event.target.closest ? event.target.closest('.js-ask') : null;
      if (!button) { return; }
      var card = button.closest('.vcard');
      if (!card) { return; }

      var fromInput = card.querySelector('.js-from');
      var toInput = card.querySelector('.js-to');
      var dates = resolveRequestedDates(fromInput && fromInput.value, toInput && toInput.value);
      var du = dates.du;
      var au = dates.au;

      var message = bookingMessageFor({
        nom: card.getAttribute('data-nom') || '',
        prixSemaineChf: card.getAttribute('data-prix') || ''
      }, labels, du, au);

      window.open('https://wa.me/' + WA_NUMBER + '?text=' + encodeURIComponent(message), '_blank', 'noopener');
    });
  }

  function renderHeadlinePrice(el, vehicles) {
    if (!el) { return; }
    var price = computeHeadlinePrice(vehicles);
    if (price == null) { price = computeHeadlinePrice(FALLBACK_VEHICLES); }
    if (price != null) { el.textContent = String(price); }
  }

  function initFleet(config) {
    config = config || {};
    var labels = LABELS[config.lang] || LABELS.fr;
    var fleetEl = (typeof document !== 'undefined') ? document.getElementById('fleet-grid') : null;
    var priceEls = (typeof document !== 'undefined') ? document.querySelectorAll('#price-x') : [];

    function renderAll(vehicles) {
      renderFleetGrid(fleetEl, vehicles, labels);
      for (var i = 0; i < priceEls.length; i++) { renderHeadlinePrice(priceEls[i], vehicles); }
    }

    renderAll(FALLBACK_VEHICLES);
    bindBookingRequests(fleetEl, labels);

    var sheetCsvUrl = config.sheetCsvUrl || SHEET_CSV_URL;
    if (!sheetCsvUrl || typeof fetch !== 'function') { return; }

    fetch(sheetCsvUrl)
      .then(function (res) { return res.ok ? res.text() : Promise.reject(new Error('bad status')); })
      .then(function (text) {
        var rows = parseCSV(text);
        var vehicles = rows.map(normalizeVehicle).filter(function (v) { return v !== null; });
        if (vehicles.length > 0) { renderAll(vehicles); }
      })
      .catch(function () { /* keep fallback rendering, no visible error */ });
  }

  return {
    parseCSV: parseCSV,
    normalizeVehicle: normalizeVehicle,
    computeHeadlinePrice: computeHeadlinePrice,
    pickLabel: pickLabel,
    parseSheetDate: parseSheetDate,
    formatSheetDate: formatSheetDate,
    availabilityOf: availabilityOf,
    resolveRequestedDates: resolveRequestedDates,
    bookingMessageFor: bookingMessageFor,
    escapeHTML: escapeHTML,
    vehicleCardHTML: vehicleCardHTML,
    FALLBACK_VEHICLES: FALLBACK_VEHICLES,
    LABELS: LABELS,
    renderFleetGrid: renderFleetGrid,
    renderHeadlinePrice: renderHeadlinePrice,
    initFleet: initFleet
  };
});
