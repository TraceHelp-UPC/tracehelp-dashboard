export default {
	MAX_BYTES: 25 * 1024 * 1024,
	EXTENSIONES: ['.pdf', '.md', '.markdown'],
	MAX_ARCHIVOS: 10,
	ID_SEGUIMIENTO: 'seguimiento-manuales',
	subiendo: false,

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

	async ejecutar(query, params) {
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

	// "manual_de-vpn.pdf" -> "manual de vpn"
	tituloDesde(nombre) {
		return String(nombre || '').replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
	},

	validarArchivo(f) {
		const nombre = (f.name || '').toLowerCase();
		if (!this.EXTENSIONES.some(ext => nombre.endsWith(ext))) return 'no es PDF ni Markdown';
		if (f.size && f.size > this.MAX_BYTES) return 'supera los 25 MB';
		return null;
	},

	validar() {
		const files = FilePickerManual.files || [];
		if (!files.length) return 'Selecciona al menos un manual en PDF o Markdown.';
		if (files.length > this.MAX_ARCHIVOS) return `Puedes subir hasta ${this.MAX_ARCHIVOS} manuales por tanda.`;
		if ((InputTituloManual.text || '').length > 200) return 'El título no puede superar los 200 caracteres.';
		return null;
	},

	// Sube los archivos seleccionados de uno en uno; un fallo no detiene a los demás
	async subir() {
		if (this.subiendo) return;
		const error = this.validar();
		if (error) {
			showAlert(error, 'warning');
			return;
		}
		const files = [...FilePickerManual.files];
		const unico = files.length === 1;
		const titulo = (InputTituloManual.text || '').trim();
		const fallidos = [];
		let subidos = 0;
		this.subiendo = true;
		try {
			for (let i = 0; i < files.length; i++) {
				const f = files[i];
				await storeValue('progresoKb', `Subiendo ${i + 1} de ${files.length}: ${f.name}`);
				const invalido = this.validarArchivo(f);
				if (invalido) {
					fallidos.push(`${f.name}: ${invalido}`);
					continue;
				}
				const params = { archivo: f, titulo: unico && titulo ? titulo : this.tituloDesde(f.name) };
				try {
					await this.ejecutar(SubirManualQuery, params);
					subidos++;
				} catch (e) {
					if (this.esCodigo(SubirManualQuery, 401)) {
						await storeValue('progresoKb', '');
						return Sesion.expulsar('Tu sesión expiró. Vuelve a iniciar sesión.');
					}
					fallidos.push(`${f.name}: ${this.detalle(SubirManualQuery, 'error al subir')}`);
				}
			}
		} finally {
			this.subiendo = false;
		}
		await storeValue('progresoKb', '');
		if (subidos) {
			resetWidget('FilePickerManual', true);
			resetWidget('InputTituloManual', true);
		}
		if (!fallidos.length) {
			showAlert(`Se subieron ${subidos} de ${files.length} manuales. Los estamos procesando.`, 'success');
		} else {
			showAlert(`Se subieron ${subidos} de ${files.length}. Fallaron ${fallidos.length}: ${fallidos.join(' | ')}`, subidos ? 'warning' : 'error');
		}
		await this.cargar();
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