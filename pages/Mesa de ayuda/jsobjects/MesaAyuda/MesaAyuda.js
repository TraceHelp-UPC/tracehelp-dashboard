export default {
  PESTANAS: { 'Mi cola': 'mine', 'Pendientes de asignación': 'unassigned', 'Escalados': 'escalated' },
  ID_REFRESCO: 'refresco-mesa',

  tienePermiso() {
    return (appsmith.store.user?.permissions || []).includes('tickets:manage');
  },

  scope() {
    return this.PESTANAS[TabsBandeja.selectedTab] || 'mine';
  },

  rutaCola(params) {
    const q = Object.entries(params)
      .filter(([, v]) => v !== undefined && v !== null && v !== '')
      .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
      .join('&');
    return q ? `queue?${q}` : 'queue';
  },

  async alCargar() {
    if (appsmith.mode === 'EDIT') {
      if (appsmith.store.accessToken) await this.refrescar();
      return;
    }
    await Sesion.verificar();
    if (!appsmith.store.accessToken) return;
    if (!this.tienePermiso()) {
      showAlert('La Mesa de ayuda es solo para analistas y especialistas.', 'warning');
      navigateTo('Inicio');
      return;
    }
    await this.refrescar();
    clearInterval(this.ID_REFRESCO);
    setInterval(() => this.refrescar(), 60000, this.ID_REFRESCO);
  },

  detalle(query, porDefecto) {
    let data = query.data;
    if (typeof data === 'string') {
      try { data = JSON.parse(data); } catch (e) { data = null; }
    }
    return (data && data.detail) || porDefecto;
  },

  esCodigo(query, codigo) {
    return String(query.responseMeta?.statusCode || '').startsWith(String(codigo));
  },

  async ejecutar(query, params = {}) {
    try {
      return await query.run(params);
    } catch (e) {
      if (!this.esCodigo(query, 401)) throw e;
      const r = await RefreshQuery.run();
      await storeValue('accessToken', r.access_token);
      return await query.run(params);
    }
  },

  async cargar() {
    const params = {
      scope: this.scope(),
      priority: SelectPrioridad.selectedOptionValue,
      search: (InputBuscar.text || '').trim(),
      page: TablaCola.pageNo || 1,
      size: Math.min(Math.max(TablaCola.pageSize || 10, 1), 100),
    };
    try {
      await this.ejecutar(ColaQuery, { ruta: this.rutaCola(params) });
    } catch (e) {
      if (this.esCodigo(ColaQuery, 401)) return Sesion.expulsar('Tu sesión expiró. Vuelve a iniciar sesión.');
      if (this.esCodigo(ColaQuery, 400) && params.page > 1) {
        resetWidget('TablaCola', true);
        await this.ejecutar(ColaQuery, { ruta: this.rutaCola({ ...params, page: 1 }) });
        return;
      }
      showAlert(this.detalle(ColaQuery, 'No pudimos cargar la bandeja.'), 'error');
    }
  },

  async metricas() {
    const consultas = {
      mine: { scope: 'mine', size: 1 },
      unassigned: { scope: 'unassigned', size: 1 },
      escalated: { scope: 'escalated', size: 1 },
      critical: { scope: 'unassigned', priority: 'CRITICAL', size: 1 },
    };
    const totales = {};
    for (const [clave, params] of Object.entries(consultas)) {
      try {
        const r = await this.ejecutar(ConteoQuery, { ruta: this.rutaCola(params) });
        totales[clave] = r.total;
      } catch (e) {
        totales[clave] = null;
      }
    }
    await storeValue('mesaMetricas', totales);
  },

  async refrescar() {
    await this.cargar();
    await this.metricas();
  },

  async cambiarPestana() {
    resetWidget('TablaCola', true);
    await this.cargar();
  },

  async cambiarPagina() {
    await this.cargar();
  },

  async filtrar() {
    resetWidget('TablaCola', true);
    await this.cargar();
  },

  async atender(fila) {
    try {
      await this.ejecutar(AtenderQuery, { id: fila._id });
      showAlert(`Tomaste ${fila['Código']}. Ya está en tu cola.`, 'success');
    } catch (e) {
      if (this.esCodigo(AtenderQuery, 401)) return Sesion.expulsar('Tu sesión expiró. Vuelve a iniciar sesión.');
      if (this.esCodigo(AtenderQuery, 422)) {
        showAlert(`Otro analista ya tomó ${fila['Código']}.`, 'warning');
      } else {
        showAlert(this.detalle(AtenderQuery, 'No pudimos tomar el ticket.'), 'error');
      }
    }
    await this.refrescar();
  },

  async verDetalle(fila) {
    try {
      await this.ejecutar(DetalleQuery, { id: fila._id });
      showModal('ModalDetalle');
    } catch (e) {
      showAlert(this.detalle(DetalleQuery, 'No pudimos abrir el ticket.'), 'error');
    }
  },

  antiguedad(fecha) {
    const min = Math.max(0, Math.round((Date.now() - new Date(fecha).getTime()) / 60000));
    if (min < 60) return `hace ${min} min`;
    if (min < 1440) return `hace ${Math.floor(min / 60)} h`;
    return `hace ${Math.floor(min / 1440)} d`;
  },

  filas() {
    return (ColaQuery.data?.items || []).map(t => ({
      _id: t.id,
      'Código': t.code,
      'Asunto': t.title,
      'Prioridad': t.priority,
      'Estado': t.status,
      'Solicitante': t.reporter_name || '—',
      'Responsable': t.assigned_analyst_name || 'Sin asignar',
      'Módulo': t.affected_module || '—',
      'Capturas': t.evidence_count,
      'Antigüedad': this.antiguedad(t.created_at),
    }));
  },

  mensajeVacio() {
    const filtros = SelectPrioridad.selectedOptionValue || (InputBuscar.text || '').trim();
    if (filtros) return 'Ningún ticket coincide con los filtros.';
    return {
      mine: 'No tienes tickets asignados. Toma uno desde Pendientes de asignación.',
      unassigned: 'No hay tickets esperando asignación.',
      escalated: 'No hay tickets escalados a Nivel 2.',
    }[this.scope()];
  },
};