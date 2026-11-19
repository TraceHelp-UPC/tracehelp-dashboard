export default {
  _sondeando: false,
  _ticksSondeo: 0,

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
    if (appsmith.store.accessToken) await this.cargarCarga();
    if (appsmith.store.accessToken && this.ticketId()) {
      this.iniciarSondeo();
      await this.cargar();
    }
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
    try {
      await this.ejecutar(HistorialQuery, { id });
    } catch (e) {
      /* El historial es complementario; si falla no bloquea el panel HITL */
    }
    if (!(await this.cargarMensajes()) && !this.esCodigo(MensajesQuery, 401)) {
      showAlert(this.detalle(MensajesQuery, 'No pudimos cargar la conversación.'), 'warning');
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
    const cat = t.category ? ` · Categoría: ${t.category}` : '';
    return `Estado: ${t.status} · Prioridad: ${t.priority}${cat} · Solicitante: ${t.reporter_name || '—'} · Responsable: ${t.assigned_analyst_name || 'sin asignar'}`;
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
    const h = HistorialQuery.data;
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
    (h?.items || []).forEach(item => {
      const motivo = item.reason ? ` — Motivo: ${item.reason}` : '';
      eventos.push({
        _orden: item.changed_at,
        Fecha: fecha(item.changed_at),
        Quién: item.changed_by_name || 'Sistema',
        Evento: `Estado: ${item.previous_status} → ${item.new_status}${motivo}`,
      });
    });
    return eventos.sort((a, b) => new Date(a._orden) - new Date(b._orden)).map(({ _orden, ...e }) => e);
  },

  // ---------- Permisos y visibilidad de controles de estado (US14 · T44)
  tienePermiso(permiso) {
    return (appsmith.store.user?.permissions || []).includes(permiso);
  },

  puedeEscalar() {
    return TicketQuery.data?.status === 'ASSIGNED_L1' && this.tienePermiso('tickets:escalate');
  },

  puedeDevolver() {
    const st = TicketQuery.data?.status;
    if (st === 'ASSIGNED_L1') return this.tienePermiso('tickets:manage');
    if (st === 'ESCALATED_L2') return this.tienePermiso('tickets:resolve_escalated');
    return false;
  },

  puedeResolverEstado() {
    const st = TicketQuery.data?.status;
    if (st === 'ASSIGNED_L1') return this.tienePermiso('tickets:manage');
    if (st === 'ESCALATED_L2') return this.tienePermiso('tickets:resolve_escalated');
    return false;
  },

  // Transitorio (D18): 'tickets:attend_l1' aún no existe en el backend; mientras tanto
  // 'tickets:escalate' (solo analista L1) lo sustituye. T82 lo reemplaza por 'tickets:attend_l1'.
  puedeAtenderL1() {
    const permisos = appsmith.store.user?.permissions || [];
    return permisos.includes('tickets:attend_l1') || permisos.includes('tickets:escalate');
  },

  // T74 (US16): la disponibilidad vive en appsmith.store.user.availability_status (la carga
  // Sesion.verificar desde /auth/me en cada página, así persiste al navegar). Actualización
  // optimista con reversión si el PATCH falla.
  async cambiarDisponibilidad(disponible) {
    const usuario = appsmith.store.user;
    if (!usuario || !this.puedeAtenderL1()) return;
    const nuevo = disponible ? 'AVAILABLE' : 'UNAVAILABLE';
    const anterior = usuario.availability_status || 'AVAILABLE';
    if (nuevo === anterior) return;
    await storeValue('user', { ...usuario, availability_status: nuevo });
    try {
      await this.ejecutar(DisponibilidadQuery, { estado: nuevo });
      showAlert(disponible ? 'Ahora estás disponible para recibir tickets.' : 'Ahora estás no disponible: no recibirás tickets nuevos.', 'success');
    } catch (e) {
      if (this.esCodigo(DisponibilidadQuery, 401)) return Sesion.expulsar('Tu sesión expiró. Vuelve a iniciar sesión.');
      await storeValue('user', { ...appsmith.store.user, availability_status: anterior });
      showAlert(this.detalle(DisponibilidadQuery, 'No pudimos cambiar tu disponibilidad.'), 'error');
    }
  },

  // T74: carga actual para la cabecera. Cuenta 'mine' (T72/T82 la afinarán a solo carga L1).
  async cargarCarga() {
    if (!this.puedeAtenderL1()) return;
    try {
      const r = await this.ejecutar(ConteoQuery, { ruta: 'queue?scope=mine&size=1' });
      await storeValue('cargaL1', r.total);
    } catch (e) {
      await storeValue('cargaL1', null);
    }
  },

  puedeRetomar() {
    const st = TicketQuery.data?.status;
    return (st === 'OPEN' || st === 'REOPENED') && this.tienePermiso('tickets:manage');
  },

  async cambiarEstado(targetStatus, reason, modal) {
    try {
      await this.ejecutar(CambiarEstadoQuery, {
        id: this.ticketId(),
        body: { status: targetStatus, reason: (reason || '').trim() || null },
      });
      if (modal) closeModal(modal);
      showAlert(`Estado actualizado a ${targetStatus}.`, 'success');
      // Invalida los contadores de la Mesa de ayuda; ella los recalcula al abrir.
      await removeValue('mesaMetricas');
      await this.cargarCarga();
    } catch (e) {
      if (this.esCodigo(CambiarEstadoQuery, 401)) return Sesion.expulsar('Tu sesión expiró. Vuelve a iniciar sesión.');
      showAlert(this.detalle(CambiarEstadoQuery, 'No pudimos cambiar el estado del ticket.'), this.esCodigo(CambiarEstadoQuery, 4) ? 'warning' : 'error');
      return;
    }
    await this.cargar();
  },

  abrirEscalar() {
    resetWidget('InputMotivoEscalar', true);
    showModal(ModalEscalar.name);
  },

  async confirmarEscalar() {
    const motivo = (InputMotivoEscalar.text || '').trim();
    if (!motivo) {
      showAlert('Ingresa el motivo para escalar el ticket a Nivel 2.', 'warning');
      return;
    }
    await this.cambiarEstado('ESCALATED_L2', motivo, ModalEscalar.name);
  },

  abrirDevolver() {
    resetWidget('InputMotivoDevolver', true);
    showModal(ModalDevolver.name);
  },

  async confirmarDevolver() {
    const motivo = (InputMotivoDevolver.text || '').trim();
    if (!motivo) {
      showAlert('Ingresa el motivo para devolver el ticket.', 'warning');
      return;
    }
    const destino = TicketQuery.data?.status === 'ESCALATED_L2' ? 'ASSIGNED_L1' : 'PENDING_ASSIGNMENT';
    await this.cambiarEstado(destino, motivo, ModalDevolver.name);
  },

  async resolverDirecto() {
    await this.cambiarEstado('RESOLVED', 'Resuelto por soporte desde consola HITL');
  },

  async retomar() {
    const destino = TicketQuery.data?.status === 'OPEN' ? 'PENDING_ASSIGNMENT' : 'ASSIGNED_L1';
    await this.cambiarEstado(destino, 'Retomado por analista desde consola HITL');
  },


  // ---------- Conversación del ticket (US26 · T86)
  datosMensajes() {
    let d = MensajesQuery.data;
    if (typeof d === 'string') {
      try { d = JSON.parse(d); } catch (e) { d = null; }
    }
    return d && Array.isArray(d.items) ? d : null;
  },

  ticketCerrado() {
    const st = TicketQuery.data?.status;
    return st === 'CLOSED' || st === 'RESOLVED';
  },

  escaparHtml(t) {
    return String(t ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  },

  fechaRelativa(iso) {
    const seg = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
    if (seg < 60) return 'hace un momento';
    if (seg < 3600) return `hace ${Math.floor(seg / 60)} min`;
    if (seg < 86400) return `hace ${Math.floor(seg / 3600)} h`;
    if (seg < 604800) return `hace ${Math.floor(seg / 86400)} d`;
    return new Date(iso).toLocaleDateString('es-PE', { dateStyle: 'medium' });
  },

  hiloHtml() {
    const raw = MensajesQuery.data;
    const estilos = '<style>'
      + 'body{font-family:Arial,Helvetica,sans-serif;margin:0;padding:8px;background:#F8FAFC;color:#0F172A;font-size:13px}'
      + '.m{max-width:85%;padding:8px 10px;margin:6px 0;border-radius:8px;border:1px solid #E2E8F0;background:#FFFFFF}'
      + '.yo{margin-left:auto;background:#DBEAFE;border-color:#2563EB}'
      + '.nota{background:#FEF3C7;border:1px solid #F59E0B}'
      + '.cab{font-size:11px;color:#64748B;margin-bottom:4px}'
      + '.eti{display:inline-block;font-weight:bold;color:#B45309;margin-left:6px}'
      + '.txt{white-space:pre-wrap;word-wrap:break-word}'
      + '.vacio{color:#64748B;text-align:center;margin-top:40px}'
      + '</style>';
    let datos = raw;
    if (typeof datos === 'string') {
      try { datos = JSON.parse(datos); } catch (e) { datos = null; }
    }
    datos = datos && Array.isArray(datos.items) ? datos : null;
    let cuerpo;
    if (!datos) {
      const fallo = /^[45]/.test(String(MensajesQuery.responseMeta?.statusCode || ''));
      cuerpo = fallo
        ? '<div class="vacio">No pudimos cargar la conversación. Reintentaremos automáticamente.</div>'
        : '<div class="vacio">Cargando mensajes…</div>';
    } else {
      const items = datos.items;
      if (!items.length) {
        cuerpo = '<div class="vacio">Aún no hay mensajes en este ticket.</div>';
      } else {
        cuerpo = items.map(m => {
          const mio = (m.author_id && m.author_id === appsmith.store.user?.id);
          const rol = m.from_reporter ? 'Colaborador' : 'Soporte';
          const nombre = mio ? 'Tú' : `${this.escaparHtml(m.author_name || rol)} · ${rol}`;
          const ia = m.is_ai_generated ? ' · Respuesta validada' : '';
          const cabecera = `${nombre}${ia}`;
          const nota = m.is_internal_note;
          const etiqueta = nota ? '<span class="eti">Nota interna · no visible para el colaborador</span>' : '';
          const clases = 'm' + (mio ? ' yo' : '') + (nota ? ' nota' : '');
          return `<div class="${clases}"><div class="cab" title="${this.escaparHtml(new Date(m.created_at).toLocaleString('es-PE'))}">${cabecera} · ${this.fechaRelativa(m.created_at)}${etiqueta}</div><div class="txt">${this.escaparHtml(m.content)}</div></div>`;
        }).join('');
      }
    }
    return `<!DOCTYPE html><html><head><meta charset="utf-8">${estilos}</head><body>${cuerpo}<script>window.scrollTo(0, document.body.scrollHeight);</script></body></html>`;
  },

  async cargarMensajes() {
    try {
      await this.ejecutar(MensajesQuery, { id: this.ticketId() });
      return true;
    } catch (e) {
      if (this.esCodigo(MensajesQuery, 401)) {
        clearInterval('sondeoMensajes');
        await Sesion.expulsar('Tu sesión expiró. Vuelve a iniciar sesión.');
      }
      return false;
    }
  },

  // Sondeo silencioso: refresca la conversación cada 8 s y el ticket cada 3 vueltas (~24 s).
  async refrescarMensajes(forzarTicket = false) {
    if (!appsmith.store.accessToken || !this.ticketId()) {
      clearInterval('sondeoMensajes');
      return;
    }
    if (this._sondeando) return;
    this._sondeando = true;
    try {
      this._ticksSondeo = (this._ticksSondeo || 0) + 1;
      const refrescarTicket = Boolean(forzarTicket) || this._ticksSondeo % 3 === 0;
      if (refrescarTicket) {
        try {
          await this.ejecutar(TicketQuery, { id: this.ticketId() });
        } catch (e) {
          if (this.esCodigo(TicketQuery, 401)) {
            clearInterval('sondeoMensajes');
            return Sesion.expulsar('Tu sesión expiró. Vuelve a iniciar sesión.');
          }
        }
      }
      await this.cargarMensajes();
      if (this.esCodigo(MensajesQuery, 401)) {
        clearInterval('sondeoMensajes');
      }
    } finally {
      this._sondeando = false;
    }
  },

  iniciarSondeo() {
    clearInterval('sondeoMensajes');
    if (!appsmith.store.accessToken || !this.ticketId()) return;
    this._ticksSondeo = 0;
    setInterval(() => Hitl.refrescarMensajes(), 8000, 'sondeoMensajes');
  },

  mensajeErrorEnvio() {
    let d = EnviarMensajeQuery.data;
    if (typeof d === 'string') {
      try { d = JSON.parse(d); } catch (e) { d = null; }
    }
    const codigo = String(EnviarMensajeQuery.responseMeta?.statusCode || '');
    if (codigo.startsWith('422')) {
      const tipo = ((d && d.errors) || [])[0]?.type;
      if (tipo === 'string_too_short') return 'El mensaje no puede estar vacío.';
      if (tipo === 'string_too_long') return 'El mensaje no puede superar los 2000 caracteres.';
      return (d && d.detail) || 'El mensaje no es válido.';
    }
    if (codigo.startsWith('403')) return (d && d.detail) || 'No tienes permiso para escribir en este ticket.';
    if (codigo.startsWith('404')) return 'El ticket ya no existe.';
    if (codigo.startsWith('409')) return (d && d.detail) || 'Este ticket no admite nuevos mensajes en su estado actual.';
    return (d && d.detail) || 'No pudimos enviar tu mensaje. Inténtalo de nuevo.';
  },

  async enviarMensaje() {
    const content = (InputMensaje.text || '').trim();
    if (!content) {
      showAlert('El mensaje no puede estar vacío.', 'warning');
      return;
    }
    if (content.length > 2000) {
      showAlert('El mensaje no puede superar los 2000 caracteres.', 'warning');
      return;
    }
    if (this.ticketCerrado()) {
      const aviso = TicketQuery.data?.status === 'RESOLVED'
        ? 'Este ticket está resuelto y no admite nuevos mensajes hasta que sea reabierto.'
        : 'Este ticket está cerrado y no admite nuevos mensajes.';
      showAlert(aviso, 'warning');
      return;
    }
    const interna = Boolean(SwNotaInterna.isSwitchedOn) && this.tienePermiso('tickets:manage');
    const body = { content, is_internal_note: interna };
    try {
      await this.ejecutar(EnviarMensajeQuery, { id: this.ticketId(), body });
    } catch (e) {
      if (this.esCodigo(EnviarMensajeQuery, 401)) return Sesion.expulsar('Tu sesión expiró. Vuelve a iniciar sesión.');
      showAlert(this.mensajeErrorEnvio(), this.esCodigo(EnviarMensajeQuery, 5) ? 'error' : 'warning');
      if (this.esCodigo(EnviarMensajeQuery, 409)) {
        try { await this.ejecutar(TicketQuery, { id: this.ticketId() }); } catch (e2) { /* el aviso ya se mostró */ }
      }
      return;
    }
    resetWidget('InputMensaje', true);
    showAlert(interna ? 'Nota interna guardada.' : 'Mensaje enviado.', 'success');
    await this.cargarMensajes();
  },

  // ---------- Corrección de clasificación (US27 · T42)
  puedeClasificar() {
    return Boolean(TicketQuery.data?.id) && this.tienePermiso('tickets:manage');
  },

  abrirClasificacion() {
    resetWidget('SelectCategoriaCorr', true);
    resetWidget('SelectPrioridadCorr', true);
    resetWidget('InputMotivoClasif', true);
    showModal(ModalClasificar.name);
  },

  async confirmarClasificacion() {
    const category = SelectCategoriaCorr.selectedOptionValue || TicketQuery.data?.category || null;
    const priority = SelectPrioridadCorr.selectedOptionValue || TicketQuery.data?.priority || null;
    const reason = (InputMotivoClasif.text || '').trim() || 'Ajuste de clasificación por analista';
    if (!category && !priority) {
      showAlert('Selecciona al menos una categoría o prioridad.', 'warning');
      return;
    }
    try {
      await this.ejecutar(ClasificacionQuery, {
        id: this.ticketId(),
        body: { category, priority, reason },
      });
      closeModal(ModalClasificar.name);
      showAlert('Clasificación del ticket actualizada.', 'success');
    } catch (e) {
      if (this.esCodigo(ClasificacionQuery, 401)) return Sesion.expulsar('Tu sesión expiró. Vuelve a iniciar sesión.');
      showAlert(this.detalle(ClasificacionQuery, 'No pudimos actualizar la clasificación.'), 'warning');
      return;
    }
    await this.cargar();
  },

  // ---------- Acciones HITL
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
