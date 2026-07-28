/* =========================================================================
   Monitor de Agências de Turismo — Brasil
   Lógica principal: estado, filtros, mapa, leads, follow-up (kanban), rejeitadas
   Arquitetura herdada do monitor Educa Bondinho, adaptada para o funil e o
   esquema de dados das agências de turismo (escala nacional).
   ========================================================================= */

const STORAGE_KEY = 'at_leads_state_v1';

const STAGES = [
  'novo_lead', 'negociacao',
  'cad_formulario', 'cad_financeira', 'cad_juridica', 'cad_ativacao', 'cad_onboarding',
  'cadastrada_sucesso',
];
const STAGE_LABELS = {
  novo_lead: 'Novo Lead / 1º Contato',
  negociacao: 'Em Negociação',
  cad_formulario: 'Cadastro: Preenchimento do Formulário',
  cad_financeira: 'Cadastro: Análise Financeira',
  cad_juridica: 'Cadastro: Assinatura do Contrato',
  cad_ativacao: 'Cadastro: Ativação da Oferta na Plataforma',
  cad_onboarding: 'Cadastro: Treinamento/On-Boarding',
  cadastrada_sucesso: 'Agência Cadastrada com Sucesso',
};
const TERMINAL_LABELS = { rejeitada: 'Rejeitada / Sem Resposta' };
const CONCLUDED_STAGE = 'cadastrada';
const CONCLUDED_LABEL = 'Concluído (Agência Cadastrada)';
const EXTRA_LABELS = {
  'sem_followup': 'Removido do funil (sem follow-up)',
  'reativado -> novo_lead': 'Reativado',
  'reativado -> cadastrada_sucesso': 'Reativado (voltou para Agência Cadastrada com Sucesso)',
};
const ALL_LABELS = { ...STAGE_LABELS, ...TERMINAL_LABELS, [CONCLUDED_STAGE]: CONCLUDED_LABEL, ...EXTRA_LABELS };

// Motivos fixos usados quando a rejeição acontece em "Novo Lead" ou "Em Negociação".
// Nas sub-etapas de Cadastro, o motivo é automático (a própria sub-etapa onde caiu).
const REJECTION_REASONS_NEGOCIACAO = [
  'Compliance',
  'Divergência Institucional',
  'Desacordo na política comercial (% por comissão)',
  'Agência em falência/reestruturação/auditoria',
  'Outros',
];
const CADASTRO_AUTO_REASON_STAGES = ['cad_formulario', 'cad_financeira', 'cad_juridica', 'cad_ativacao', 'cad_onboarding'];

const REGIAO_COLORS = {
  'Norte': '#3CBAB6',
  'Nordeste': '#EB4A74',
  'Centro-Oeste': '#1E6EB7',
  'Sudeste': '#4C4F9E',
  'Sul': '#D98E2B',
};
const CONTACTED_COLOR = '#adb5bd';

function hashColor(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) hash = str.charCodeAt(i) + ((hash << 5) - hash);
  const h = Math.abs(hash) % 360;
  return `hsl(${h}, 62%, 45%)`;
}

/* ------------------------------------------------------------------------
   ESTADO — Firestore (tempo real) com fallback local (localStorage)
   ------------------------------------------------------------------------ */

const COLLECTION_NAME = 'leads_state';
let db = null;
let firestoreReady = false;
let firebaseConfigured = typeof FIREBASE_CONFIG !== 'undefined'
  && FIREBASE_CONFIG.apiKey && !String(FIREBASE_CONFIG.apiKey).startsWith('SUA_')
  && (typeof FIREBASE_PROJECT_GUARD_OK === 'undefined' || FIREBASE_PROJECT_GUARD_OK);

function loadLocalState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch (e) {
    console.error('Erro ao ler localStorage', e);
    return {};
  }
}

let LEADS_STATE = loadLocalState();

function saveLocalState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(LEADS_STATE));
}

function setSyncStatus(status) {
  const el = document.getElementById('sync-status');
  if (!el) return;
  const labels = { local: '● modo local', conectando: '● conectando...', sincronizado: '● sincronizado', erro: '● erro de conexão' };
  el.textContent = labels[status] || status;
  el.classList.toggle('synced', status === 'sincronizado');
}

function initFirebase() {
  if (!firebaseConfigured || typeof firebase === 'undefined') {
    setSyncStatus('local');
    return;
  }
  try {
    firebase.initializeApp(FIREBASE_CONFIG);
    db = firebase.firestore();
    db.enablePersistence({ synchronizeTabs: true }).catch(() => { /* ok se ja habilitado em outra aba */ });
    setSyncStatus('conectando');
    firebase.auth().onAuthStateChanged(user => {
      if (user) {
        firestoreReady = true;
        listenToLeadsState();
      }
    });
    firebase.auth().signInAnonymously().catch(err => {
      console.error('Erro no login anônimo do Firebase', err);
      setSyncStatus('erro');
    });
  } catch (e) {
    console.error('Erro ao inicializar Firebase', e);
    setSyncStatus('erro');
  }
}

let leadsListenerAttached = false;

function listenToLeadsState() {
  if (leadsListenerAttached) return;
  leadsListenerAttached = true;
  db.collection(COLLECTION_NAME).onSnapshot(snapshot => {
    snapshot.docChanges().forEach(change => {
      const id = change.doc.id;
      if (change.type === 'removed') delete LEADS_STATE[id];
      else LEADS_STATE[id] = change.doc.data();
    });
    setSyncStatus('sincronizado');
    refreshAll();
  }, err => {
    console.error('Erro ao ouvir Firestore', err);
    setSyncStatus('erro');
  });
}

function getState(id) {
  return LEADS_STATE[id] || {
    contacted: false, followup_stage: null, followup_history: [],
    rejection_category: null, rejection_notes: '',
    conclusion_notes: '',
    notes: '',
  };
}

function writeRemote(id, patch) {
  if (!firestoreReady || !db) return;
  db.collection(COLLECTION_NAME).doc(String(id)).set(patch, { merge: true }).catch(e => {
    console.error('Erro ao gravar no Firestore', e);
    setSyncStatus('erro');
  });
}

function setState(id, patch) {
  const cur = getState(id);
  LEADS_STATE[id] = { ...cur, ...patch, last_updated_by: currentUserName || cur.last_updated_by || null, updated_at: new Date().toISOString() };
  if (firestoreReady) {
    writeRemote(id, { ...patch, last_updated_by: currentUserName || null, updated_at: new Date().toISOString() });
  } else {
    saveLocalState();
  }
}

function pushHistory(id, stage) {
  const entry = { stage, ts: new Date().toISOString(), by: currentUserName || 'Não identificado' };
  const cur = getState(id);
  const hist = cur.followup_history ? [...cur.followup_history, entry] : [entry];
  LEADS_STATE[id] = { ...cur, followup_history: hist };
  if (firestoreReady) {
    db.collection(COLLECTION_NAME).doc(String(id)).set({
      followup_history: firebase.firestore.FieldValue.arrayUnion(entry),
    }, { merge: true }).catch(e => console.error('Erro ao gravar histórico', e));
  } else {
    saveLocalState();
  }
}

function markContacted(id, value) {
  const cur = getState(id);
  const patch = { contacted: value };
  if (value && !cur.followup_stage) {
    patch.followup_stage = 'novo_lead';
    setState(id, patch);
    pushHistory(id, 'novo_lead');
  } else {
    setState(id, patch);
  }
  refreshAll();
}

function moveStage(id, stage) {
  setState(id, { followup_stage: stage });
  pushHistory(id, stage);
  refreshAll();
}

function rejectAgencia(id, category, notes) {
  setState(id, {
    followup_stage: 'rejeitada',
    rejection_category: category || null,
    rejection_notes: notes || '',
    contacted: true,
  });
  pushHistory(id, 'rejeitada');
  refreshAll();
}

function reactivateAgencia(id) {
  setState(id, { followup_stage: 'novo_lead', rejection_category: null, rejection_notes: '' });
  pushHistory(id, 'reativado -> novo_lead');
  refreshAll();
}

function completeAgencia(id, notes) {
  setState(id, {
    followup_stage: CONCLUDED_STAGE,
    conclusion_notes: notes || '',
    contacted: true,
  });
  pushHistory(id, CONCLUDED_STAGE);
  refreshAll();
}

function revertConclusion(id) {
  setState(id, { followup_stage: 'cadastrada_sucesso', conclusion_notes: '' });
  pushHistory(id, 'reativado -> cadastrada_sucesso');
  refreshAll();
}

function clearFollowup(id) {
  setState(id, {
    followup_stage: null, contacted: false,
    rejection_category: null, rejection_notes: '',
    conclusion_notes: '',
  });
  pushHistory(id, 'sem_followup');
  refreshAll();
}

function deleteHistoryEntry(id, index) {
  const cur = getState(id);
  const hist = (cur.followup_history || []).slice();
  if (index < 0 || index >= hist.length) return;
  const target = hist[index];

  if (firestoreReady && db) {
    const ref = db.collection(COLLECTION_NAME).doc(String(id));
    db.runTransaction(tx => tx.get(ref).then(doc => {
      const remoteHist = (doc.exists && doc.data().followup_history) || [];
      const newHist = remoteHist.filter(h => h.ts !== target.ts);
      tx.set(ref, {
        followup_history: newHist,
        last_updated_by: currentUserName || null,
        updated_at: new Date().toISOString(),
      }, { merge: true });
    })).catch(e => console.error('Erro ao excluir entrada do histórico', e));
  }

  hist.splice(index, 1);
  LEADS_STATE[id] = { ...cur, followup_history: hist };
  if (!firestoreReady) saveLocalState();
  refreshAll();
}

/* ------------------------------------------------------------------------
   IDENTIFICAÇÃO DO USUÁRIO
   ------------------------------------------------------------------------ */

const USER_NAME_KEY = 'at_user_name';
let currentUserName = localStorage.getItem(USER_NAME_KEY) || null;

const OUTRO_VALUE = '__outro__';

function renderUserBadge() {
  const badge = document.getElementById('current-user-badge');
  if (!badge) return;
  badge.textContent = currentUserName ? `👤 ${currentUserName}` : '👤 Definir nome';
}

function openNameModal() {
  const overlay = document.getElementById('name-modal-overlay');
  const select = document.getElementById('name-modal-select');
  const input = document.getElementById('name-modal-input');
  const skipBtn = document.getElementById('name-modal-skip');

  select.innerHTML = '<option value="">Selecione seu nome...</option>';
  input.hidden = true;
  input.value = '';

  skipBtn.hidden = !currentUserName;
  skipBtn.textContent = 'Cancelar';

  const roster = (typeof TEAM_MEMBERS !== 'undefined' && TEAM_MEMBERS.length) ? TEAM_MEMBERS : [];
  roster.forEach(name => {
    const opt = document.createElement('option');
    opt.value = name; opt.textContent = name;
    select.appendChild(opt);
  });
  const outroOpt = document.createElement('option');
  outroOpt.value = OUTRO_VALUE;
  outroOpt.textContent = 'Meu nome não está na lista...';
  select.appendChild(outroOpt);

  overlay.classList.add('open');
}

function initNameModal() {
  const overlay = document.getElementById('name-modal-overlay');
  const select = document.getElementById('name-modal-select');
  const input = document.getElementById('name-modal-input');

  function confirmName() {
    let val = '';
    if (select.value === OUTRO_VALUE) {
      val = input.value.trim();
    } else {
      val = select.value;
    }
    if (!val) {
      select.style.borderColor = '#d63b3b';
      if (select.value === OUTRO_VALUE) input.focus(); else select.focus();
      return;
    }
    currentUserName = val;
    localStorage.setItem(USER_NAME_KEY, val);
    renderUserBadge();
    select.style.borderColor = '';
    overlay.classList.remove('open');
  }

  select.addEventListener('change', () => {
    input.hidden = select.value !== OUTRO_VALUE;
    if (!input.hidden) input.focus();
  });
  document.getElementById('name-modal-confirm').addEventListener('click', confirmName);
  document.getElementById('name-modal-skip').addEventListener('click', () => {
    overlay.classList.remove('open');
  });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') confirmName(); });
  document.getElementById('current-user-badge').addEventListener('click', openNameModal);

  renderUserBadge();
  if (!currentUserName) openNameModal();
}

/* ------------------------------------------------------------------------
   DADOS
   ------------------------------------------------------------------------ */

const AGENCIAS = AGENCIAS_DATA; // vem de data/agencias.js
const AGENCIAS_BY_ID = {};
AGENCIAS.forEach(a => { AGENCIAS_BY_ID[a.id] = a; });

// Alguns cadastros trazem um "Nome Fantasia" que na verdade é só um
// placeholder sem sentido (ex.: "*", "**", ".", "N/D") em vez do nome
// comercial real. Nesses casos exibimos a Razão Social no lugar, para não
// mostrar "*" como se fosse o nome da agência.
const PLACEHOLDER_FANTASIA_RE = /^[*.\-#]+$/;
function displayName(agencia) {
  const f = (agencia.fantasia || '').trim();
  if (!f || PLACEHOLDER_FANTASIA_RE.test(f) || f.toUpperCase() === 'N/D' || f.toUpperCase() === 'ND') {
    return agencia.razao;
  }
  return agencia.fantasia;
}
function attrEscape(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

const ALL_REGIOES = Array.from(new Set(AGENCIAS.map(a => a.regiao))).sort();
const ALL_CATEGORIAS = Array.from(new Set(AGENCIAS.map(a => a.categoria))).sort();
const ALL_SEGMENTOS = Array.from(new Set(AGENCIAS.flatMap(a => a.segmentos))).sort();

const REGIAO_TO_UFS = {};
AGENCIAS.forEach(a => {
  if (!REGIAO_TO_UFS[a.regiao]) REGIAO_TO_UFS[a.regiao] = new Set();
  REGIAO_TO_UFS[a.regiao].add(a.uf);
});
Object.keys(REGIAO_TO_UFS).forEach(r => { REGIAO_TO_UFS[r] = Array.from(REGIAO_TO_UFS[r]).sort(); });
const ALL_UFS = Array.from(new Set(AGENCIAS.map(a => a.uf))).sort();

const UF_TO_MUNICIPIOS = {};
AGENCIAS.forEach(a => {
  if (!UF_TO_MUNICIPIOS[a.uf]) UF_TO_MUNICIPIOS[a.uf] = new Set();
  UF_TO_MUNICIPIOS[a.uf].add(a.municipio);
});
Object.keys(UF_TO_MUNICIPIOS).forEach(uf => { UF_TO_MUNICIPIOS[uf] = Array.from(UF_TO_MUNICIPIOS[uf]).sort(); });

const selectedSegmentosMapa = new Set();
const selectedSegmentosLeads = new Set();

/* ------------------------------------------------------------------------
   MULTISELECT (segmentos turísticos)
   ------------------------------------------------------------------------ */

function buildMultiselect(containerId, selectedSet, onChange) {
  const container = document.getElementById(containerId);
  const toggle = container.querySelector('.multiselect-toggle');
  const panel = container.querySelector('.multiselect-panel');

  ALL_SEGMENTOS.forEach(seg => {
    const label = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = seg;
    cb.addEventListener('change', () => {
      if (cb.checked) selectedSet.add(seg); else selectedSet.delete(seg);
      updateToggleLabel();
      onChange();
    });
    label.appendChild(cb);
    label.appendChild(document.createTextNode(seg));
    panel.appendChild(label);
  });

  function updateToggleLabel() {
    if (selectedSet.size === 0) toggle.textContent = 'Todos os segmentos ▾';
    else if (selectedSet.size === 1) toggle.textContent = [...selectedSet][0] + ' ▾';
    else toggle.textContent = selectedSet.size + ' segmentos selecionados ▾';
  }

  toggle.addEventListener('click', (e) => {
    e.stopPropagation();
    document.querySelectorAll('.multiselect.open').forEach(el => { if (el !== container) el.classList.remove('open'); });
    container.classList.toggle('open');
  });
  document.addEventListener('click', (e) => {
    if (!container.contains(e.target)) container.classList.remove('open');
  });
}

function matchesSegmentos(agencia, selectedSet) {
  if (selectedSet.size === 0) return true;
  return agencia.segmentos.some(s => selectedSet.has(s));
}

/* ------------------------------------------------------------------------
   FILTROS DE LOCALIDADE EM CASCATA (Região > Estado > Município)
   ------------------------------------------------------------------------ */

function setupLocationCascade(prefix, onChange) {
  const regiaoSel = document.getElementById(`filter-regiao-${prefix}`);
  const ufSel = document.getElementById(`filter-uf-${prefix}`);
  const muniContainer = document.getElementById(`municipio-filter-${prefix}`);
  const muniToggle = muniContainer.querySelector('.multiselect-toggle');
  const muniSearch = muniContainer.querySelector('.multiselect-search');
  const muniOptions = muniContainer.querySelector('.multiselect-options');
  const selectedMunicipios = new Set();

  ALL_REGIOES.forEach(r => {
    const o = document.createElement('option'); o.value = r; o.textContent = r; regiaoSel.appendChild(o);
  });
  ALL_UFS.forEach(uf => {
    const o = document.createElement('option'); o.value = uf; o.textContent = uf; ufSel.appendChild(o);
  });

  function repopulateUf() {
    const regiao = regiaoSel.value;
    const keep = ufSel.value;
    ufSel.innerHTML = '<option value="">Todos</option>';
    const ufs = regiao ? REGIAO_TO_UFS[regiao] : ALL_UFS;
    ufs.forEach(uf => {
      const o = document.createElement('option'); o.value = uf; o.textContent = uf; ufSel.appendChild(o);
    });
    ufSel.value = ufs.includes(keep) ? keep : '';
  }

  function updateMuniToggleLabel() {
    if (selectedMunicipios.size === 0) {
      muniToggle.textContent = ufSel.value ? 'Todos os municípios ▾' : 'Selecione um Estado (UF) primeiro';
    } else if (selectedMunicipios.size === 1) {
      muniToggle.textContent = [...selectedMunicipios][0] + ' ▾';
    } else {
      muniToggle.textContent = selectedMunicipios.size + ' municípios selecionados ▾';
    }
  }

  // Município depende do Estado (UF) selecionado — a lista de opções (e a
  // seleção atual) é reconstruída toda vez que o Estado muda. Permite
  // selecionar vários municípios ao mesmo tempo (ex.: Gramado + Canela na
  // Serra Gaúcha), com um campo de busca porque alguns estados têm
  // centenas de municípios.
  function repopulateMunicipio() {
    const uf = ufSel.value;
    selectedMunicipios.clear();
    muniOptions.innerHTML = '';
    muniSearch.value = '';
    if (!uf) {
      muniContainer.classList.add('disabled');
      muniContainer.classList.remove('open');
      updateMuniToggleLabel();
      return;
    }
    muniContainer.classList.remove('disabled');
    (UF_TO_MUNICIPIOS[uf] || []).forEach(m => {
      const label = document.createElement('label');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.value = m;
      cb.addEventListener('change', () => {
        if (cb.checked) selectedMunicipios.add(m); else selectedMunicipios.delete(m);
        updateMuniToggleLabel();
        onChange();
      });
      label.appendChild(cb);
      label.appendChild(document.createTextNode(m));
      muniOptions.appendChild(label);
    });
    updateMuniToggleLabel();
  }

  muniContainer.classList.add('disabled');

  regiaoSel.addEventListener('change', () => { repopulateUf(); repopulateMunicipio(); onChange(); });
  ufSel.addEventListener('change', () => { repopulateMunicipio(); onChange(); });

  muniToggle.addEventListener('click', (e) => {
    e.stopPropagation();
    if (muniContainer.classList.contains('disabled')) return;
    document.querySelectorAll('.multiselect.open').forEach(el => { if (el !== muniContainer) el.classList.remove('open'); });
    muniContainer.classList.toggle('open');
    if (muniContainer.classList.contains('open')) muniSearch.focus();
  });
  document.addEventListener('click', (e) => {
    if (!muniContainer.contains(e.target)) muniContainer.classList.remove('open');
  });
  muniSearch.addEventListener('click', (e) => e.stopPropagation());
  muniSearch.addEventListener('input', () => {
    const term = muniSearch.value.trim().toLowerCase();
    muniOptions.querySelectorAll('label').forEach(label => {
      label.style.display = label.textContent.toLowerCase().includes(term) ? '' : 'none';
    });
  });

  return {
    get regiao() { return regiaoSel.value; },
    get uf() { return ufSel.value; },
    municipios: selectedMunicipios,
  };
}

function matchesLocation(agencia, cascade) {
  if (cascade.municipios && cascade.municipios.size > 0 && !cascade.municipios.has(agencia.municipio)) return false;
  if (cascade.uf && agencia.uf !== cascade.uf) return false;
  if (cascade.regiao && agencia.regiao !== cascade.regiao) return false;
  return true;
}

/* ==========================================================================
   MAPA
   ========================================================================== */

let map, clusterGroup;
let mapaCascade;

function initMap() {
  map = L.map('map', { zoomControl: true }).setView([-14.235, -51.9253], 4);
  L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
    maxZoom: 19,
    subdomains: 'abcd',
    attribution: '&copy; OpenStreetMap contributors &copy; CARTO',
  }).addTo(map);
  clusterGroup = L.markerClusterGroup({
    iconCreateFunction: function (cluster) {
      const count = cluster.getChildCount();
      let size = 30;
      if (count > 20) size = 36;
      if (count > 100) size = 42;
      if (count > 1000) size = 50;
      return L.divIcon({
        html: `<div class="at-cluster" style="background:${CLUSTER_COLOR};width:${size}px;height:${size}px;font-size:${size / 3.1}px;">${count}</div>`,
        className: '',
        iconSize: [size, size],
      });
    },
    spiderfyOnMaxZoom: true,
    showCoverageOnHover: false,
    maxClusterRadius: 50,
    disableClusteringAtZoom: 14,
  });
  map.addLayer(clusterGroup);
}

const CLUSTER_COLOR = '#4C4F9E';

// Ícones são apenas configuração (não têm estado próprio), então podem ser
// reaproveitados entre marcadores da mesma cor/status — com até ~57 mil
// agências, isso evita recriar dezenas de milhares de ícones idênticos a
// cada renderização do mapa.
const _iconCache = {};
function markerIcon(color, contacted) {
  const key = color + '|' + contacted;
  if (_iconCache[key]) return _iconCache[key];
  const c = contacted ? CONTACTED_COLOR : color;
  const op = contacted ? 0.5 : 0.92;
  const icon = L.divIcon({
    className: '',
    html: `<div class="at-marker" style="opacity:${op};background:${c};width:9px;height:9px;"></div>`,
    iconSize: [9, 9],
    iconAnchor: [4, 4],
    popupAnchor: [0, -6],
  });
  _iconCache[key] = icon;
  return icon;
}

function colorFor(agencia) {
  return REGIAO_COLORS[agencia.regiao] || hashColor(agencia.regiao);
}

function popupHtml(agencia) {
  const st = getState(agencia.id);
  const segBadges = agencia.segmentos.slice(0, 4).map(s => `<span class="badge">${s}</span>`).join('');
  const geoNote = agencia.geo_fonte !== 'municipio'
    ? `<div class="geo-note">📍 Localização aproximada (centróide do estado)</div>`
    : `<div class="geo-note">📍 Localização aproximada (centróide do município)</div>`;
  return `
    <div class="school-popup" data-id="${agencia.id}">
      <h4>${displayName(agencia)}</h4>
      <div class="badges">${segBadges}</div>
      <div class="phone">📞 ${agencia.tel_com || agencia.tel_inst ? `<a href="tel:${agencia.tel_com || agencia.tel_inst}">${agencia.tel_com || agencia.tel_inst}</a>` : '<em>não informado</em>'}</div>
      ${geoNote}
      <label class="check-row">
        <input type="checkbox" class="popup-check" ${st.contacted ? 'checked' : ''}> Marcar como contactada
      </label>
    </div>`;
}

function filteredMapa() {
  const contactedFilter = document.getElementById('contacted-filter-mapa').value;
  const categoria = document.getElementById('filter-categoria-mapa').value;
  let list = AGENCIAS.filter(a => matchesLocation(a, mapaCascade) && matchesSegmentos(a, selectedSegmentosMapa));
  if (categoria) list = list.filter(a => a.categoria === categoria);
  if (contactedFilter === 'ocultar') list = list.filter(a => !getState(a.id).contacted);
  else if (contactedFilter === 'somente') list = list.filter(a => getState(a.id).contacted);
  return list;
}

function renderMap() {
  clusterGroup.clearLayers();
  const list = filteredMapa();
  const markers = [];

  list.forEach(a => {
    if (a.lat == null || a.lng == null) return;
    const st = getState(a.id);
    const color = colorFor(a);
    const marker = L.marker([a.lat, a.lng], { icon: markerIcon(color, st.contacted) });
    // O conteúdo do popup só é montado quando ele é realmente aberto (função
    // lazy), em vez de gerar o HTML das ~57 mil agências de uma vez.
    marker.bindPopup(() => popupHtml(a));
    marker.on('popupopen', (e) => {
      const el = e.popup.getElement();
      const cb = el.querySelector('.popup-check');
      cb.addEventListener('change', () => markContacted(a.id, cb.checked));
    });
    markers.push(marker);
  });
  // addLayers (em lote) é bem mais rápido que addLayer chamado ~57 mil
  // vezes, pois o clustering reindexa tudo de uma vez só.
  clusterGroup.addLayers(markers);

  document.getElementById('mapa-stats').innerHTML = `<b>${list.length}</b> agências nesta visualização`;
  renderLegend(list);
}

function renderLegend(list) {
  const el = document.getElementById('map-legend');
  const cats = {};
  list.forEach(a => { cats[a.regiao] = (cats[a.regiao] || 0) + 1; });
  const entries = Object.entries(cats).sort((a, b) => b[1] - a[1]);
  let html = '<h4>Legenda — Região</h4>';
  entries.forEach(([label, count]) => {
    const color = REGIAO_COLORS[label] || hashColor(label);
    html += `<div class="legend-item"><span class="legend-dot" style="background:${color}"></span> ${label} (${count})</div>`;
  });
  html += `<div class="legend-item" style="margin-top:6px;"><span class="legend-dot" style="background:${CONTACTED_COLOR}"></span> Já contactada</div>`;
  el.innerHTML = html;
}

/* ==========================================================================
   LEADS
   ========================================================================== */

let leadsCascade;

function filteredLeads() {
  const term = document.getElementById('search-leads').value.trim().toLowerCase();
  const categoria = document.getElementById('filter-categoria-leads').value;
  const contactedFilter = document.getElementById('contacted-filter-leads').value;

  return AGENCIAS.filter(a => {
    if (term && !a.fantasia.toLowerCase().includes(term) && !a.razao.toLowerCase().includes(term)) return false;
    if (!matchesLocation(a, leadsCascade)) return false;
    if (categoria && a.categoria !== categoria) return false;
    if (!matchesSegmentos(a, selectedSegmentosLeads)) return false;
    const contacted = getState(a.id).contacted;
    if (contactedFilter === 'ocultar' && contacted) return false;
    if (contactedFilter === 'somente' && !contacted) return false;
    return true;
  });
}

function statusPill(agencia) {
  const st = getState(agencia.id);
  if (!st.followup_stage) return '<span class="status-pill sem-status">Sem contato</span>';
  if (ALL_LABELS[st.followup_stage]) return `<span class="status-pill ${st.followup_stage}">${ALL_LABELS[st.followup_stage]}</span>`;
  return '';
}

// Com até ~57 mil agências, montar uma linha de tabela por registro de uma
// só vez trava a interface. Renderizamos só uma "página" por vez, com um
// botão para carregar mais — a exportação em CSV continua exportando a
// lista filtrada inteira, não só o que está visível na tela.
const LEADS_PAGE_SIZE = 200;
let leadsLimit = LEADS_PAGE_SIZE;

function renderLeads() {
  const tbody = document.getElementById('leads-tbody');
  const list = filteredLeads();
  const shown = list.slice(0, leadsLimit);
  tbody.innerHTML = '';
  shown.forEach(a => {
    const st = getState(a.id);
    const tr = document.createElement('tr');
    if (st.contacted) tr.classList.add('contacted');
    const name = displayName(a);
    tr.innerHTML = `
      <td class="check-col"><input type="checkbox" ${st.contacted ? 'checked' : ''} data-id="${a.id}" class="leads-check"></td>
      <td title="${attrEscape(name)}">${name}</td>
      <td title="${attrEscape(a.municipio + '/' + a.uf)}">${a.municipio}/${a.uf}</td>
      <td title="${attrEscape(a.categoria)}">${a.categoria}</td>
      <td>${a.tel_com || a.tel_inst || '—'}</td>
      <td>${statusPill(a)}</td>
    `;
    tr.addEventListener('click', (e) => {
      if (e.target.classList.contains('leads-check')) return;
      openSidebar(a.id);
    });
    tbody.appendChild(tr);
  });
  tbody.querySelectorAll('.leads-check').forEach(cb => {
    cb.addEventListener('click', (e) => e.stopPropagation());
    cb.addEventListener('change', () => markContacted(cb.dataset.id, cb.checked));
  });
  if (list.length > shown.length) {
    const tr = document.createElement('tr');
    const restante = list.length - shown.length;
    tr.innerHTML = `<td colspan="6" style="text-align:center;padding:16px;">
      <button class="btn-export" id="leads-load-more">Carregar mais (${Math.min(LEADS_PAGE_SIZE, restante)} de ${restante} restantes)</button>
    </td>`;
    tbody.appendChild(tr);
    tr.querySelector('#leads-load-more').addEventListener('click', () => {
      leadsLimit += LEADS_PAGE_SIZE;
      renderLeads();
    });
  }
  const pagStats = list.length > shown.length ? ` (mostrando ${shown.length})` : '';
  document.getElementById('leads-stats').innerHTML = `<b>${list.length}</b> agências encontradas${pagStats}`;
}

function resetLeadsAndRender() {
  leadsLimit = LEADS_PAGE_SIZE;
  renderLeads();
}

/* ==========================================================================
   FOLLOW UP (KANBAN)
   ========================================================================== */

function agenciasInFollowup() {
  const term = document.getElementById('search-followup').value.trim().toLowerCase();
  return AGENCIAS.filter(a => {
    const st = getState(a.id);
    if (!STAGES.includes(st.followup_stage)) return false;
    if (term && !a.fantasia.toLowerCase().includes(term) && !a.razao.toLowerCase().includes(term)) return false;
    return true;
  });
}

function renderKanban() {
  const board = document.getElementById('kanban-board');
  board.innerHTML = '';
  const list = agenciasInFollowup();

  STAGES.forEach(stage => {
    const col = document.createElement('div');
    col.className = 'kanban-col';
    const inStage = list.filter(a => getState(a.id).followup_stage === stage);
    col.innerHTML = `<div class="kanban-col-header">${STAGE_LABELS[stage]} <span class="count">${inStage.length}</span></div>
      <div class="kanban-col-body" data-stage="${stage}"></div>`;
    board.appendChild(col);

    const body = col.querySelector('.kanban-col-body');
    if (inStage.length === 0) {
      body.innerHTML = '<div class="kanban-empty">Nenhuma agência nesta etapa</div>';
    }
    inStage.forEach(a => body.appendChild(kanbanCard(a, stage)));

    body.addEventListener('dragover', (e) => { e.preventDefault(); body.classList.add('drag-over'); });
    body.addEventListener('dragleave', () => body.classList.remove('drag-over'));
    body.addEventListener('drop', (e) => {
      e.preventDefault();
      body.classList.remove('drag-over');
      const id = e.dataTransfer.getData('text/plain');
      moveStage(id, stage);
    });
  });
}

function renderHistoryList(history, options = {}) {
  const { deletable = false, agenciaId = null } = options;
  const hist = history || [];
  const items = hist.slice().reverse();
  if (items.length === 0) return '<div class="history-item">Nenhuma interação registrada ainda.</div>';
  return items.map((h, revIdx) => {
    const originalIndex = (hist.length - 1) - revIdx;
    const label = ALL_LABELS[h.stage] || h.stage;
    const author = h.by ? ` <strong>· ${h.by}</strong>` : '';
    const delBtn = deletable
      ? `<button class="history-delete" type="button" data-agencia-id="${agenciaId}" data-index="${originalIndex}" title="Excluir esta entrada do histórico">✕</button>`
      : '';
    return `<div class="history-item"><span class="history-text">${new Date(h.ts).toLocaleString('pt-BR')} — ${label}${author}</span>${delBtn}</div>`;
  }).join('');
}

function kanbanCard(agencia, stage) {
  const card = document.createElement('div');
  card.className = 'kanban-card';
  card.draggable = true;
  card.dataset.id = agencia.id;
  const st = getState(agencia.id);
  const hist = st.followup_history || [];
  const responsavel = st.last_updated_by ? ` · resp.: ${st.last_updated_by}` : '';
  card.innerHTML = `
    <h5>${displayName(agencia)}</h5>
    <div class="kc-meta">${agencia.municipio}/${agencia.uf} · ${agencia.tel_com || agencia.tel_inst || 'sem telefone'}${responsavel}</div>
    <div class="kc-actions">
      <select class="stage-move">
        <option value="">Sem follow-up iniciado</option>
        ${STAGES.map(s => `<option value="${s}" ${s === stage ? 'selected' : ''}>${STAGE_LABELS[s]}</option>`).join('')}
      </select>
      <div class="kc-buttons">
        <button class="kc-reject" title="Marcar como rejeitada ou sem resposta">✕ Rejeitar</button>
        ${stage === 'cadastrada_sucesso' ? '<button class="kc-complete" title="Concluir cadastro">✓ Concluir</button>' : ''}
      </div>
    </div>
    <button class="kc-history-toggle" type="button">🕒 Histórico (${hist.length})</button>
    <div class="kc-history" hidden>${renderHistoryList(hist)}</div>
  `;
  card.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/plain', String(agencia.id)); });
  card.addEventListener('click', (e) => {
    if (e.target.tagName === 'SELECT' || e.target.tagName === 'BUTTON') return;
    openSidebar(agencia.id);
  });
  card.querySelector('.kc-history-toggle').addEventListener('click', (e) => {
    e.stopPropagation();
    const box = card.querySelector('.kc-history');
    box.hidden = !box.hidden;
  });
  card.querySelector('.stage-move').addEventListener('change', (e) => {
    const val = e.target.value;
    if (!val) {
      const ok = confirm(`Remover "${displayName(agencia)}" do funil de follow-up? Ela volta a aparecer como "Sem contato" no Mapa e em Leads.`);
      if (ok) clearFollowup(agencia.id);
      else renderKanban();
    } else {
      moveStage(agencia.id, val);
    }
  });
  card.querySelector('.kc-reject').addEventListener('click', (e) => {
    e.stopPropagation();
    openRejectModal(agencia.id);
  });
  const completeBtn = card.querySelector('.kc-complete');
  if (completeBtn) {
    completeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openCompleteModal(agencia.id);
    });
  }
  return card;
}

/* ------------------------------------------------------------------------
   MODAL: REJEITAR / SEM RESPOSTA
   ------------------------------------------------------------------------ */

let rejectModalTargetId = null;

function initRejectModal() {
  const overlay = document.getElementById('reject-modal-overlay');
  const reasonField = document.getElementById('reject-reason-field');
  const reasonSelect = document.getElementById('reject-reason-select');
  const notesInput = document.getElementById('reject-notes-input');

  REJECTION_REASONS_NEGOCIACAO.forEach(r => {
    const opt = document.createElement('option');
    opt.value = r; opt.textContent = r;
    reasonSelect.appendChild(opt);
  });

  document.getElementById('reject-modal-cancel').addEventListener('click', () => {
    overlay.classList.remove('open');
    rejectModalTargetId = null;
    refreshSidebarIfOpen();
    renderKanban();
  });

  document.getElementById('reject-modal-confirm').addEventListener('click', () => {
    const id = rejectModalTargetId;
    if (id == null) return;
    const st = getState(id);
    const isAuto = CADASTRO_AUTO_REASON_STAGES.includes(st.followup_stage);
    let category;
    if (isAuto) {
      category = STAGE_LABELS[st.followup_stage];
    } else {
      if (!reasonSelect.value) {
        reasonSelect.style.borderColor = '#d63b3b';
        reasonSelect.focus();
        return;
      }
      category = reasonSelect.value;
    }
    const notes = notesInput.value.trim();
    overlay.classList.remove('open');
    rejectModalTargetId = null;
    rejectAgencia(id, category, notes);
  });
}

function openRejectModal(id) {
  const overlay = document.getElementById('reject-modal-overlay');
  const reasonField = document.getElementById('reject-reason-field');
  const reasonAuto = document.getElementById('reject-reason-auto');
  const reasonAutoText = document.getElementById('reject-reason-auto-text');
  const reasonSelect = document.getElementById('reject-reason-select');
  const notesInput = document.getElementById('reject-notes-input');
  const st = getState(id);

  rejectModalTargetId = id;
  reasonSelect.style.borderColor = '';
  notesInput.value = st.rejection_notes || '';

  const isAuto = CADASTRO_AUTO_REASON_STAGES.includes(st.followup_stage);
  if (isAuto) {
    reasonField.hidden = true;
    reasonAuto.hidden = false;
    reasonAutoText.textContent = STAGE_LABELS[st.followup_stage];
  } else {
    reasonField.hidden = false;
    reasonAuto.hidden = true;
    reasonSelect.value = st.rejection_category && REJECTION_REASONS_NEGOCIACAO.includes(st.rejection_category) ? st.rejection_category : '';
  }

  overlay.classList.add('open');
}

/* ------------------------------------------------------------------------
   MODAL: CONCLUIR (AGÊNCIA CADASTRADA)
   ------------------------------------------------------------------------ */

let completeModalTargetId = null;

function initCompleteModal() {
  const overlay = document.getElementById('complete-modal-overlay');
  const notesInput = document.getElementById('complete-notes-input');

  document.getElementById('complete-modal-cancel').addEventListener('click', () => {
    overlay.classList.remove('open');
    completeModalTargetId = null;
    refreshSidebarIfOpen();
    renderKanban();
  });

  document.getElementById('complete-modal-confirm').addEventListener('click', () => {
    const notes = notesInput.value.trim();
    const id = completeModalTargetId;
    overlay.classList.remove('open');
    completeModalTargetId = null;
    if (id != null) completeAgencia(id, notes);
  });
}

function openCompleteModal(id) {
  const st = getState(id);
  if (st.followup_stage !== 'cadastrada_sucesso') {
    alert('Só é possível concluir uma agência que já passou pela etapa "Agência Cadastrada com Sucesso".');
    return;
  }
  completeModalTargetId = id;
  const overlay = document.getElementById('complete-modal-overlay');
  const notesInput = document.getElementById('complete-notes-input');
  notesInput.value = st.conclusion_notes || '';
  overlay.classList.add('open');
}

/* ==========================================================================
   AGÊNCIA REJEITADA / SEM RESPOSTA
   ========================================================================== */

function agenciasRejeitadas() {
  return AGENCIAS.filter(a => getState(a.id).followup_stage === 'rejeitada');
}

function renderRejeitadas() {
  const tbody = document.getElementById('rejeitadas-tbody');
  tbody.innerHTML = '';
  agenciasRejeitadas().forEach(a => {
    const st = getState(a.id);
    const hist = st.followup_history || [];
    // etapa em que a agencia estava logo ANTES de ser rejeitada (penultima entrada do historico)
    const beforeReject = hist.length >= 2 ? hist[hist.length - 2] : null;
    const etapaOrigem = beforeReject ? (ALL_LABELS[beforeReject.stage] || beforeReject.stage) : '—';
    const lastHist = hist.slice(-1)[0];
    const date = lastHist ? new Date(lastHist.ts).toLocaleString('pt-BR') : '—';
    const tr = document.createElement('tr');
    const name = displayName(a);
    tr.innerHTML = `
      <td title="${attrEscape(name)}">${name}</td>
      <td title="${attrEscape(a.municipio + '/' + a.uf)}">${a.municipio}/${a.uf}</td>
      <td>${a.tel_com || a.tel_inst || '—'}</td>
      <td title="${attrEscape(etapaOrigem)}">${etapaOrigem}</td>
      <td title="${attrEscape(st.rejection_category || '')}">${st.rejection_category || '—'}</td>
      <td class="cell-wrap">${st.rejection_notes || '—'}</td>
      <td>${date}</td>
      <td><button class="btn-reactivate" data-id="${a.id}">Reativar</button></td>
    `;
    tr.querySelector('td:not(:last-child)').parentElement.addEventListener('click', (e) => {
      if (e.target.classList.contains('btn-reactivate')) return;
      openSidebar(a.id);
    });
    tbody.appendChild(tr);
  });
  tbody.querySelectorAll('.btn-reactivate').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      reactivateAgencia(btn.dataset.id);
    });
  });
}

/* ==========================================================================
   AGÊNCIAS CADASTRADAS
   ========================================================================== */

function agenciasCadastradas() {
  return AGENCIAS.filter(a => getState(a.id).followup_stage === CONCLUDED_STAGE);
}

function renderCadastradas() {
  const tbody = document.getElementById('cadastradas-tbody');
  tbody.innerHTML = '';
  agenciasCadastradas().forEach(a => {
    const st = getState(a.id);
    const lastHist = (st.followup_history || []).slice(-1)[0];
    const date = lastHist ? new Date(lastHist.ts).toLocaleString('pt-BR') : '—';
    const tr = document.createElement('tr');
    const name = displayName(a);
    tr.innerHTML = `
      <td title="${attrEscape(name)}">${name}</td>
      <td title="${attrEscape(a.municipio + '/' + a.uf)}">${a.municipio}/${a.uf}</td>
      <td>${a.tel_com || a.tel_inst || '—'}</td>
      <td title="${attrEscape(a.responsavel || '')}">${a.responsavel || '—'}</td>
      <td class="cell-wrap">${st.conclusion_notes || '—'}</td>
      <td>${date}</td>
      <td><button class="btn-reactivate" data-id="${a.id}">Reverter</button></td>
    `;
    tr.querySelector('td:not(:last-child)').parentElement.addEventListener('click', (e) => {
      if (e.target.classList.contains('btn-reactivate')) return;
      openSidebar(a.id);
    });
    tbody.appendChild(tr);
  });
  tbody.querySelectorAll('.btn-reactivate').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      revertConclusion(btn.dataset.id);
    });
  });
}

/* ==========================================================================
   SIDEBAR DE DETALHES
   ========================================================================== */

let sidebarOpenId = null;

function refreshSidebarIfOpen() {
  if (sidebarOpenId != null && document.getElementById('sidebar-overlay').classList.contains('open')) {
    openSidebar(sidebarOpenId);
  }
}

function websiteLink(agencia) {
  if (!agencia.website) return '—';
  // Em vez de imprimir a URL inteira (que pode ser bem longa e empurrar a
  // largura do sidebar), mostramos um botão curto e fixo; a URL completa
  // fica disponível no title (tooltip) e no href.
  const url = agencia.website;
  const displayUrl = url.replace(/^https?:\/\//i, '').replace(/\/$/, '');
  return `<a class="website-link" href="${attrEscape(url)}" target="_blank" rel="noopener noreferrer" title="${attrEscape(displayUrl)}">🔗 Visitar site</a>`;
}

function openSidebar(id) {
  sidebarOpenId = id;
  const a = AGENCIAS_BY_ID[id];
  const st = getState(id);
  const overlay = document.getElementById('sidebar-overlay');
  const content = document.getElementById('sidebar-content');

  const historyHtml = renderHistoryList(st.followup_history, { deletable: true, agenciaId: id });

  const rejectionBlock = st.followup_stage === 'rejeitada' ? `
    <hr>
    <div class="info-label" style="margin-bottom:6px;">Detalhes da rejeição</div>
    <div class="info-grid">
      <div class="full"><div class="info-label">Motivo</div><div class="info-value">${st.rejection_category || '—'}</div></div>
      <div class="full"><div class="info-label">Observações</div><div class="info-value">${st.rejection_notes || '—'}</div></div>
    </div>
  ` : '';

  const conclusionBlock = st.followup_stage === CONCLUDED_STAGE ? `
    <hr>
    <div class="info-label" style="margin-bottom:6px;">Detalhes da conclusão</div>
    <div class="info-grid">
      <div class="full"><div class="info-label">Observações</div><div class="info-value">${st.conclusion_notes || '—'}</div></div>
    </div>
  ` : '';

  const segBadges = a.segmentos.map(s => `<span class="badge">${s}</span>`).join('') || '—';

  content.innerHTML = `
    <h2>${displayName(a)}</h2>
    <div class="muted-line">${a.razao} · CNPJ ${a.id}</div>
    <div class="muted-line">${a.municipio} / ${a.uf} · ${a.regiao}</div>

    <div class="info-grid">
      <div><div class="info-label">Categoria de Atuação</div><div class="info-value">${a.categoria}</div></div>
      <div><div class="info-label">Porte</div><div class="info-value">${a.porte}</div></div>
      <div><div class="info-label">Situação Cadastral</div><div class="info-value">${a.situacao}</div></div>
      <div><div class="info-label">Data de Abertura</div><div class="info-value">${a.abertura ? formatDateOnlyBR(a.abertura) : '—'}${a.idade != null ? ` (${a.idade} anos)` : ''}</div></div>
      <div class="full"><div class="info-label">Endereço</div><div class="info-value">${a.endereco}</div></div>
      <div class="full"><div class="info-label">Segmentos Turísticos</div><div class="info-value">${segBadges}</div></div>
      <div><div class="info-label">Nome do Responsável</div><div class="info-value">${a.responsavel || '—'}</div></div>
      <div><div class="info-label">Telefone Institucional</div><div class="info-value">${a.tel_inst || '—'}</div></div>
      <div><div class="info-label">E-mail do Usuário Administrador</div><div class="info-value">${a.email_admin || '—'}</div></div>
      <div><div class="info-label">Telefone Comercial</div><div class="info-value">${a.tel_com || '—'}</div></div>
      <div><div class="info-label">E-mail Comercial</div><div class="info-value">${a.email_com || '—'}</div></div>
      <div><div class="info-label">Website</div><div class="info-value">${websiteLink(a)}</div></div>
    </div>

    <label class="check-row" style="margin-bottom:14px;">
      <input type="checkbox" id="sidebar-contacted" ${st.contacted ? 'checked' : ''}> Marcar como contactada
    </label>

    <hr>
    <div class="info-label" style="margin-bottom:6px;">Etapa de Follow-up</div>
    <select class="stage-select" id="sidebar-stage">
      <option value="" ${!st.followup_stage ? 'selected' : ''}>Sem follow-up iniciado</option>
      ${STAGES.map(stg => `<option value="${stg}" ${st.followup_stage === stg ? 'selected' : ''}>${STAGE_LABELS[stg]}</option>`).join('')}
      ${Object.keys(TERMINAL_LABELS).map(stg => `<option value="${stg}" ${st.followup_stage === stg ? 'selected' : ''}>${TERMINAL_LABELS[stg]}</option>`).join('')}
      <option value="${CONCLUDED_STAGE}" ${st.followup_stage === CONCLUDED_STAGE ? 'selected' : ''}>${CONCLUDED_LABEL}</option>
    </select>
    ${rejectionBlock}
    ${conclusionBlock}

    <hr>
    <div class="info-label" style="margin-bottom:6px;">Notas internas</div>
    <textarea id="sidebar-notes" placeholder="Anotações do time comercial...">${st.notes || ''}</textarea>
    <button class="btn-primary" id="sidebar-save-notes">Salvar notas</button>

    <hr>
    <div class="info-label" style="margin-bottom:6px;">Histórico de contato</div>
    ${historyHtml}
  `;

  content.querySelector('#sidebar-contacted').addEventListener('change', (e) => markContacted(id, e.target.checked));
  content.querySelector('#sidebar-stage').addEventListener('change', (e) => {
    const val = e.target.value;
    if (!val) { clearFollowup(id); return; }
    if (val === 'rejeitada') {
      openRejectModal(id);
      return;
    }
    if (val === CONCLUDED_STAGE) {
      if (st.followup_stage !== 'cadastrada_sucesso') {
        alert('Só é possível concluir uma agência que já passou pela etapa "Agência Cadastrada com Sucesso".');
        openSidebar(id);
        return;
      }
      openCompleteModal(id);
      return;
    }
    moveStage(id, val);
  });
  content.querySelector('#sidebar-save-notes').addEventListener('click', () => {
    setState(id, { notes: content.querySelector('#sidebar-notes').value });
    refreshAll();
  });
  content.querySelectorAll('.history-delete').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const index = Number(btn.dataset.index);
      const ok = confirm('Excluir esta entrada do histórico? Essa ação não pode ser desfeita.');
      if (ok) deleteHistoryEntry(id, index);
    });
  });

  overlay.classList.add('open');
}

document.getElementById('sidebar-close').addEventListener('click', () => {
  document.getElementById('sidebar-overlay').classList.remove('open');
});
document.getElementById('sidebar-overlay').addEventListener('click', (e) => {
  if (e.target.id === 'sidebar-overlay') e.target.classList.remove('open');
});

/* ==========================================================================
   TABS
   ========================================================================== */

document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('panel-' + btn.dataset.tab).classList.add('active');
    currentTab = btn.dataset.tab;
    if (typeof tabDirty !== 'undefined' && tabDirty[currentTab]) renderTab(currentTab);
    if (btn.dataset.tab === 'mapa' && map) setTimeout(() => map.invalidateSize(), 50);
  });
});

/* ==========================================================================
   FORMATAÇÃO
   ========================================================================== */

function formatDateOnlyBR(dateStr) {
  if (!dateStr) return '—';
  const parts = String(dateStr).split('-');
  if (parts.length !== 3) return dateStr;
  const [y, m, d] = parts;
  return `${d}/${m}/${y}`;
}

function stageAtualLabel(agencia) {
  const st = getState(agencia.id);
  if (!st.followup_stage) return 'Sem contato';
  return ALL_LABELS[st.followup_stage] || st.followup_stage;
}

/* ==========================================================================
   EXPORTAÇÕES CSV
   ========================================================================== */

function csvEscape(value) {
  const s = (value === null || value === undefined) ? '' : String(value);
  if (/[;"\n\r]/.test(s) || s !== s.trim()) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function downloadCSV(filename, headers, rows) {
  const lines = [headers.map(csvEscape).join(';')];
  rows.forEach(row => lines.push(row.map(csvEscape).join(';')));
  const csvContent = '﻿' + lines.join('\r\n');
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function todayStamp() {
  return new Date().toISOString().slice(0, 10);
}

function historyToCSVCell(history) {
  const hist = history || [];
  if (hist.length === 0) return '—';
  return hist.map(h => {
    const label = ALL_LABELS[h.stage] || h.stage;
    const author = h.by ? ` (${h.by})` : '';
    return `${new Date(h.ts).toLocaleString('pt-BR')} — ${label}${author}`;
  }).join(' | ');
}

function exportMapaCSV() {
  const headers = [
    'CNPJ', 'Nome Fantasia', 'Razão Social', 'Município', 'UF', 'Região', 'Categoria de Atuação',
    'Segmentos Turísticos', 'Telefone Comercial', 'Endereço', 'Latitude', 'Longitude',
    'Precisão da Localização', 'Contactada', 'Etapa Atual',
  ];
  const rows = filteredMapa().map(a => {
    const st = getState(a.id);
    return [
      a.id, displayName(a), a.razao, a.municipio, a.uf, a.regiao, a.categoria,
      a.segmentos.join(', '), a.tel_com || a.tel_inst || '—', a.endereco,
      a.lat != null ? String(a.lat).replace('.', ',') : '—',
      a.lng != null ? String(a.lng).replace('.', ',') : '—',
      a.geo_fonte === 'municipio' ? 'Centróide do Município' : 'Centróide do Estado',
      st.contacted ? 'Sim' : 'Não', stageAtualLabel(a),
    ];
  });
  downloadCSV(`monitor-agencias-mapa-${todayStamp()}.csv`, headers, rows);
}

function exportLeadsCSV() {
  const headers = [
    'CNPJ', 'Nome Fantasia', 'Razão Social', 'Município', 'UF', 'Região', 'Categoria de Atuação',
    'Segmentos Turísticos', 'Telefone Comercial', 'Contactada', 'Status',
  ];
  const rows = filteredLeads().map(a => {
    const st = getState(a.id);
    return [
      a.id, displayName(a), a.razao, a.municipio, a.uf, a.regiao, a.categoria,
      a.segmentos.join(', '), a.tel_com || a.tel_inst || '—',
      st.contacted ? 'Sim' : 'Não', stageAtualLabel(a),
    ];
  });
  downloadCSV(`monitor-agencias-leads-${todayStamp()}.csv`, headers, rows);
}

function exportFollowupCSV() {
  const headers = [
    'CNPJ', 'Agência', 'Telefone', 'Município/UF', 'Etapa Atual', 'Responsável',
    'Data do Primeiro Contato', 'Data da Última Atualização', 'Histórico Completo', 'Notas Internas',
  ];
  const rows = agenciasInFollowup().map(a => {
    const st = getState(a.id);
    const hist = st.followup_history || [];
    const first = hist.length > 0 ? new Date(hist[0].ts).toLocaleString('pt-BR') : '—';
    const lastUpdate = st.updated_at ? new Date(st.updated_at).toLocaleString('pt-BR') : '—';
    return [
      a.id, displayName(a), a.tel_com || a.tel_inst || '—', `${a.municipio}/${a.uf}`, stageAtualLabel(a),
      st.last_updated_by || '—', first, lastUpdate,
      historyToCSVCell(hist), st.notes || '—',
    ];
  });
  downloadCSV(`monitor-agencias-followup-${todayStamp()}.csv`, headers, rows);
}

function exportRejeitadasCSV() {
  const headers = ['CNPJ', 'Agência', 'Telefone', 'Município/UF', 'Motivo', 'Observações', 'Data', 'Responsável'];
  const rows = agenciasRejeitadas().map(a => {
    const st = getState(a.id);
    const lastHist = (st.followup_history || []).slice(-1)[0];
    const date = lastHist ? new Date(lastHist.ts).toLocaleString('pt-BR') : '—';
    return [
      a.id, displayName(a), a.tel_com || a.tel_inst || '—', `${a.municipio}/${a.uf}`,
      st.rejection_category || '—', st.rejection_notes || '—', date, st.last_updated_by || '—',
    ];
  });
  downloadCSV(`monitor-agencias-rejeitadas-${todayStamp()}.csv`, headers, rows);
}

function exportCadastradasCSV() {
  const headers = ['CNPJ', 'Agência', 'Telefone', 'Município/UF', 'Responsável', 'Observações', 'Data de Conclusão'];
  const rows = agenciasCadastradas().map(a => {
    const st = getState(a.id);
    const lastHist = (st.followup_history || []).slice(-1)[0];
    const date = lastHist ? new Date(lastHist.ts).toLocaleString('pt-BR') : '—';
    return [
      a.id, displayName(a), a.tel_com || a.tel_inst || '—', `${a.municipio}/${a.uf}`,
      a.responsavel || '—', st.conclusion_notes || '—', date,
    ];
  });
  downloadCSV(`monitor-agencias-cadastradas-${todayStamp()}.csv`, headers, rows);
}

document.getElementById('btn-export-mapa').addEventListener('click', exportMapaCSV);
document.getElementById('btn-export-leads').addEventListener('click', exportLeadsCSV);
document.getElementById('btn-export-followup').addEventListener('click', exportFollowupCSV);
document.getElementById('btn-export-rejeitadas').addEventListener('click', exportRejeitadasCSV);
document.getElementById('btn-export-cadastradas').addEventListener('click', exportCadastradasCSV);

/* ==========================================================================
   INIT
   ========================================================================== */

// Renderizar as 5 abas inteiras (mapa com até ~57 mil marcadores, tabela de
// leads, kanban, rejeitadas, cadastradas) a cada pequena mudança de estado
// era o maior gargalo de performance do site. Agora só a aba atualmente
// visível é re-renderizada na hora; as demais ficam marcadas como
// "desatualizadas" (dirty) e só são realmente redesenhadas quando o
// usuário clica nelas.
let currentTab = 'mapa';
const TAB_RENDERERS = {
  mapa: renderMap,
  leads: renderLeads,
  followup: renderKanban,
  cadastradas: renderCadastradas,
  rejeitadas: renderRejeitadas,
};
const tabDirty = { mapa: true, leads: true, followup: true, cadastradas: true, rejeitadas: true };

function renderTab(tab) {
  if (!TAB_RENDERERS[tab]) return;
  TAB_RENDERERS[tab]();
  tabDirty[tab] = false;
}

function refreshAll() {
  Object.keys(tabDirty).forEach(t => { tabDirty[t] = true; });
  renderTab(currentTab);
  refreshSidebarIfOpen();
}

function debounce(fn, wait) {
  let t;
  return function (...args) {
    clearTimeout(t);
    t = setTimeout(() => fn.apply(this, args), wait);
  };
}

function populateCategoriaSelects() {
  ['mapa', 'leads'].forEach(prefix => {
    const sel = document.getElementById(`filter-categoria-${prefix}`);
    ALL_CATEGORIAS.forEach(c => {
      const o = document.createElement('option'); o.value = c; o.textContent = c; sel.appendChild(o);
    });
  });
}

function init() {
  initNameModal();
  initRejectModal();
  initCompleteModal();
  initFirebase();
  initMap();
  buildMultiselect('segmento-filter-mapa', selectedSegmentosMapa, renderMap);
  buildMultiselect('segmento-filter-leads', selectedSegmentosLeads, resetLeadsAndRender);
  populateCategoriaSelects();
  mapaCascade = setupLocationCascade('mapa', renderMap);
  leadsCascade = setupLocationCascade('leads', resetLeadsAndRender);

  document.getElementById('legend-toggle').addEventListener('click', () => {
    document.getElementById('map-legend').classList.toggle('open');
  });
  document.getElementById('filter-categoria-mapa').addEventListener('change', renderMap);
  document.getElementById('contacted-filter-mapa').addEventListener('change', renderMap);
  document.getElementById('filter-categoria-leads').addEventListener('change', resetLeadsAndRender);
  document.getElementById('contacted-filter-leads').addEventListener('change', resetLeadsAndRender);
  document.getElementById('search-leads').addEventListener('input', debounce(resetLeadsAndRender, 200));
  document.getElementById('search-followup').addEventListener('input', debounce(renderKanban, 200));

  // A aba inicial (Mapa) é renderizada de cara; as outras só quando visitadas.
  renderTab(currentTab);
}

init();
