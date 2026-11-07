export default {
	MAX_BYTES: 25 * 1024 * 1024,
	EXTENSIONES: ['.pdf', '.md', '.markdown'],
	ID_SEGUIMIENTO: 'seguimiento-manuales',

	tienePermiso() {
		return (appsmith.store.user?.permissions || []).includes('kb:write');
	},

	async alCargar() {
		if (appsmith.mode === 'EDIT') {
			if (appsmith.store.accessToken) await this.cargar();
			return;
		}
		await Sesion.verificar();
		if (!appsmith.store.accessToken) return; // verificar() ya lo mandó al Login
		if (!this.tienePermiso()) {
			showAlert('Solo el Líder de TI puede gestionar la base de conocimiento.', 'warning');
			navigateTo('Inicio');
			return;
		}
		await this.cargar();
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

	async ejecutar(query) {
		try {
			return await query.run();
		} catch (e) {
			if (!this.esCodigo(query, 401)) throw e;
			const r = await RefreshQuery.run();
			await storeValue('accessToken', r.access_token);
			return await query.run();
		}
	},

	async cargar() {
		try {
			await this.ejecutar(ListarManualesQuery);
		} catch (e) {
			if (this.esCodigo(ListarManualesQuery, 401)) return Sesion.expulsar('Tu sesión expiró. Vuelve a iniciar sesión.');
			showAlert(this.detalle(ListarManualesQuery, 'No pudimos cargar los manuales.'), 'error');
			return;
		}
		this.vigilar();
	},

	enProceso() {
		return (ListarManualesQuery.data || []).some(d => d.status === 'PENDING' || d.status === 'PROCESSING');
	},

	// Mientras haya manuales en cola o procesándose, refresca la tabla cada 5 segundos
	vigilar() {
		clearInterval(this.ID_SEGUIMIENTO);
		if (!this.enProceso()) return;
		setInterval(async () => {
			try { await ListarManualesQuery.run(); } catch (e) { /* se reintenta en la siguiente vuelta */ }
			if (!this.enProceso()) {
				clearInterval(this.ID_SEGUIMIENTO);
				showAlert('La ingesta terminó. Revisa el estado de cada manual.', 'info');
			}
		}, 5000, this.ID_SEGUIMIENTO);
	},

	validar() {
		const f = (FilePickerManual.files || [])[0];
		if (!f) return 'Selecciona un manual en PDF o Markdown.';
		const nombre = (f.name || '').toLowerCase();
		if (!this.EXTENSIONES.some(ext => nombre.endsWith(ext))) return `"${f.name}" no es PDF ni Markdown.`;
		if (f.size && f.size > this.MAX_BYTES) return `"${f.name}" supera los 25 MB.`;
		if ((InputTituloManual.text || '').length > 200) return 'El título no puede superar los 200 caracteres.';
		return null;
	},

	async subir() {
		const error = this.validar();
		if (error) {
			showAlert(error, 'warning');
			return;
		}
		const nombre = FilePickerManual.files[0].name;
		try {
			await this.ejecutar(SubirManualQuery);
			showAlert(`Recibimos "${nombre}". Lo estamos procesando.`, 'success');
			resetWidget('FilePickerManual', true);
			resetWidget('InputTituloManual', true);
			await this.cargar();
		} catch (e) {
			if (this.esCodigo(SubirManualQuery, 401)) return Sesion.expulsar('Tu sesión expiró. Vuelve a iniciar sesión.');
			showAlert(this.detalle(SubirManualQuery, 'No pudimos subir el manual. Intenta de nuevo.'), 'error');
		}
	},

	contar(estado) {
		const docs = ListarManualesQuery.data || [];
		return estado ? docs.filter(d => d.status === estado).length : docs.length;
	},

	filas() {
		return (ListarManualesQuery.data || []).map(d => ({
			'Título': d.title,
			'Archivo': d.file_name,
			'Formato': d.format,
			'Tamaño (MB)': (d.size_bytes / 1048576).toFixed(1),
			'Estado': d.status,
			'Fragmentos': d.status === 'VECTORIZED' ? d.chunk_count : '—',
			'Fecha': new Date(d.created_at).toLocaleString('es-PE', { dateStyle: 'short', timeStyle: 'short' }),
			'Detalle': d.error_message || '',
		}));
	},
};