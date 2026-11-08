export default {
  ticketId() {
    return appsmith.URL.queryParams.ticketId;
  },

  // ---------- Helpers
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

  // ---------- Carga
  async alCargar() {
    if (appsmith.mode !== 'EDIT') {
      await Sesion.verificar();
      if (!appsmith.store.accessToken) return;
      if (!(appsmith.store.user?.permissions || []).includes('tickets:manage')) {
        showAlert('El espacio HITL es solo para analistas y especialistas.', 'warning');
        return navigateTo('Inicio');
      }
      if (!this.ticketId()) {
        showAlert('Elige un ticket desde la Mesa de ayuda.', 'info');
        return navigateTo('Mesa de ayuda');
      }
    }
    if (appsmith.store.accessToken && this.ticketId()) await this.cargar();
  },

  async cargar() {
    const id = this.ticketId();
    try {
      await this.ejecutar(TicketQuery, { id });
    } catch (e) {
      if (this.esCodigo(TicketQuery, 401)) return Sesion.expulsar('Tu sesión expiró. Vuelve a iniciar sesión.');
      showAlert(this.detalle(TicketQuery, 'No pudimos abrir el ticket.'), 'error');
      return navigateTo('Mesa de ayuda');
    }
    try {
      await this.ejecutar(DiagnosticoQuery, { id });
    } catch (e) {
      if (!this.esCodigo(DiagnosticoQuery, 404)) {
        showAlert(this.detalle(DiagnosticoQuery, 'No pudimos cargar el diagnóstico.'), 'error');
      }
    }
    const primera = (TicketQuery.data?.evidences || [])[0];
    if (primera) await this.cargarCaptura(primera.id);
  },

  opcionesCaptura() {
    return (TicketQuery.data?.evidences || []).map((e, i) => ({ label: `Captura ${i + 1}: ${e.file_name}`, value: e.id }));
  },

  async cargarCaptura(evidenceId) {
    const id = evidenceId || SelectCaptura.selectedOptionValue;
    if (!id) return;
    try {
      await this.ejecutar(EvidenciaQuery, { id: this.ticketId(), evidenceId: id });
    } catch (e) {
      showAlert('No pudimos cargar la captura.', 'warning');
    }
  },

  // ---------- Textos de paneles
  meta() {
    const t = TicketQuery.data;
    if (!t) return '';
    return `Estado: ${t.status} · Prioridad: ${t.priority} · Solicitante: ${t.reporter_name || '—'} · Responsable: ${t.assigned_analyst_name || 'sin asignar'}`;
  },

  ocrTexto() {
    const o = DiagnosticoQuery.data?.ocr;
    if (!o) return '';
    const codigos = o.error_codes.length ? o.error_codes.join(', ') : 'ninguno';
    const texto = o.legible ? (o.text || '') : 'La captura no se pudo leer.';
    return `Lectura de la captura (OCR)<br/>Códigos de error: ${codigos}<br/>${texto}`;
  },

  confianzaTexto() {
    const d = DiagnosticoQuery.data;
    if (!d) return this.esCodigo(DiagnosticoQuery, 404) ? 'El triaje automático está en curso…' : '';
    if (!d.confidence_level) return 'Sin evaluación de evidencia';
    const nombres = { SELF_SERVICE: 'Evidencia fuerte', GROUNDED: 'Evidencia suficiente', LOW_CONFIDENCE: 'Evidencia insuficiente' };
    return `${nombres[d.confidence_level] || d.confidence_level} · similitud ${d.confidence_score?.toFixed(2)} (umbral ${d.similarity_threshold})`;
  },

  colorConfianza() {
    return { SELF_SERVICE: '#10B981', GROUNDED: '#2563EB', LOW_CONFIDENCE: '#F59E0B' }[DiagnosticoQuery.data?.confidence_level] || '#64748B';
  },

  estadoRevisionTexto() {
    return {
      PENDING_REVIEW: 'Propuesta de la IA pendiente de validación',
      SELF_SERVICE_PROPOSED: 'Propuesta enviada al colaborador como autoservicio',
      NOT_APPLICABLE: 'La IA no generó una respuesta',
      APPROVED: 'Respuesta aprobada',
      EDITED_AND_APPROVED: 'Respuesta editada y aprobada',
      REJECTED: 'Respuesta de la IA rechazada',
      MANUAL_RESPONSE: 'Respondido manualmente',
    }[DiagnosticoQuery.data?.review_status] || '';
  },

  respuesta() {
    const d = DiagnosticoQuery.data;
    if (!d) return {};
    if (d.manual_response) return { summary: 'Respuesta manual', steps: [d.manual_response] };
    return d.final_answer || d.ai_answer || {};
  },

  pasosTexto() {
    return (this.respuesta().steps || []).map((s, i) => `${i + 1}. ${s}`).join('<br/>');
  },

  fuentesTexto() {
    const fuentes = DiagnosticoQuery.data?.ai_answer?.sources || [];
    if (!fuentes.length) return '';
    return 'Fuentes:<br/>' + fuentes.map(f => `[${f.reference}] ${f.citation} · similitud ${f.similarity}`).join('<br/>');
  },

  motivoSinRespuesta() {
    const d = DiagnosticoQuery.data;
    if (!d) return '';
    return `La IA no propuso una solución: ${d.outcome_reason || 'sin evidencia suficiente en los manuales'}. Responde manualmente al colaborador.`;
  },

  bitacora() {
    const t = TicketQuery.data;
    const d = DiagnosticoQuery.data;
    if (!t) return [];
    const fecha = f => new Date(f).toLocaleString('es-PE', { dateStyle: 'short', timeStyle: 'short' });
    const eventos = [{ _orden: t.created_at, Fecha: fecha(t.created_at), Quién: t.reporter_name || 'Colaborador', Evento: 'Registró el incidente' }];
    if (d) {
      eventos.push({ _orden: d.created_at, Fecha: fecha(d.created_at), Quién: 'Triaje automático', Evento: `Diagnóstico: ${d.outcome} (${d.confidence_level || 'sin evaluación'})` });
      if (d.review) {
        const nota = d.review.rejection_reason ? `: ${d.review.rejection_reason}` : '';
        eventos.push({ _orden: d.review.reviewed_at, Fecha: fecha(d.review.reviewed_at), Quién: d.review.reviewer_name || 'Analista', Evento: `${this.estadoRevisionTexto()}${nota}` });
      }
    }
    (t.comments || []).forEach(c => eventos.push({
      _orden: c.created_at,
      Fecha: fecha(c.created_at),
      Quién: c.author_name || '—',
      Evento: `${c.is_internal_note ? 'Nota interna' : 'Respuesta al colaborador'}: ${c.content.slice(0, 80)}${c.content.length > 80 ? '…' : ''}`,
    }));
    return eventos.sort((a, b) => new Date(a._orden) - new Date(b._orden)).map(({ _orden, ...e }) => e);
  },

  // ---------- Acciones
  puede(accion) {
    return (DiagnosticoQuery.data?.allowed_actions || []).includes(accion);
  },

  async tomar() {
    try {
      await this.ejecutar(TomarQuery, { id: this.ticketId() });
      showAlert(`Tomaste ${TicketQuery.data.code}.`, 'success');
    } catch (e) {
      showAlert(this.esCodigo(TomarQuery, 422) ? 'Otro analista ya tomó este ticket.' : this.detalle(TomarQuery, 'No pudimos tomar el ticket.'), 'warning');
    }
    await this.cargar();
  },

  async revisar(body, mensaje, modal) {
    try {
      const r = await this.ejecutar(RevisarQuery, { diagnosisId: DiagnosticoQuery.data.diagnosis_id, body });
      if (modal) closeModal(modal);
      showAlert(r.ticket_resolved ? `${mensaje} ${TicketQuery.data.code} quedó resuelto.` : mensaje, 'success');
    } catch (e) {
      if (this.esCodigo(RevisarQuery, 401)) return Sesion.expulsar('Tu sesión expiró. Vuelve a iniciar sesión.');
      showAlert(this.detalle(RevisarQuery, 'No pudimos guardar la revisión.'), this.esCodigo(RevisarQuery, 4) ? 'warning' : 'error');
      if (this.esCodigo(RevisarQuery, 409)) { if (modal) closeModal(modal); }
      else return;
    }
    await this.cargar();
  },

  async aprobar() {
    await this.revisar({ decision: 'APPROVE' }, 'Respuesta aprobada.');
  },

  abrirEditar() {
    resetWidget('InputResumenEditado_', true);
    resetWidget('InputResumenEditado_Copy', true);
    showModal(ModalEditar.name);
  },

  async editar() {
    const steps = (InputResumenEditado_Copy.text || '').split('\n').map(s => s.trim()).filter(Boolean);
    await this.revisar({ decision: 'EDIT_AND_APPROVE', summary: InputResumenEditado_.text, steps }, 'Respuesta editada y aprobada.', ModalEditar.name);
  },

  async rechazar() {
    await this.revisar({ decision: 'REJECT', reason: Input1.text }, 'Respuesta rechazada. Ahora responde manualmente o escala el ticket.', ModalRechazar.name);
  },

  async responder() {
    await this.revisar({ decision: 'MANUAL_RESPONSE', response: InputRespuestaManual.text }, 'Respuesta enviada.', ModalManual.name);
  },
};
