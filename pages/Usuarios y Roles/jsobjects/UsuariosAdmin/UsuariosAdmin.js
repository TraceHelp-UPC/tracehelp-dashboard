export default {
	ROLES: {
		COLLABORATOR: 'Colaborador',
		ANALYST_L1: 'Analista de Soporte L1',
		SPECIALIST_L2: 'Especialista L2',
		IT_LEADER: 'Líder de TI',
	},
	GRUPOS: {
		REDES: 'Redes',
		APLICACIONES: 'Aplicaciones',
		INFRAESTRUCTURA: 'Infraestructura',
		SEGURIDAD: 'Seguridad',
	},
	ID_BUSQUEDA: 'busqueda-usuarios',
	guardando: false,

	tienePermiso() {
		return (appsmith.store.user?.permissions || []).includes('iam:admin');
	},

	esYo(id) {
		return !!id && id === appsmith.store.user?.id;
	},

	async alCargar() {
		if (appsmith.mode === 'EDIT') {
			if (appsmith.store.accessToken) await this.cargar();
			return;
		}
		await Sesion.verificar();
		if (!appsmith.store.accessToken) return; // verificar() ya lo mandó al Login
		if (!this.tienePermiso()) {
			showAlert('Solo el Líder de TI puede gestionar usuarios y roles.', 'warning');
			navigateTo('Inicio');
			return;
		}
		await this.cargar();
	},

	// Lee el Problem Details (application/problem+json) de una consulta fallida
	problema(query) {
		let data = query.data;
		if (typeof data === 'string') {
			try { data = JSON.parse(data); } catch (e) { data = null; }
		}
		return data || {};
	},

	detalle(query, porDefecto) {
		return this.problema(query).detail || porDefecto;
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

	// Mensaje claro por código de estado; el 401 lo maneja quien llama (cierra la sesión)
	mensajeError(query, porDefecto) {
		const p = this.problema(query);
		const tipo = String(p.type || '');
		if (this.esCodigo(query, 403)) return 'No tienes permiso para gestionar usuarios. Se requiere el rol Líder de TI.';
		if (this.esCodigo(query, 404)) return 'El usuario ya no existe. Actualizamos la lista.';
		if (this.esCodigo(query, 409)) return 'Ya existe una cuenta con ese correo. Usa otro correo.';
		if (this.esCodigo(query, 422)) {
			if (tipo.endsWith('self-lockout')) return 'No puedes quitarte tu propio rol ni desactivarte.';
			if (tipo.endsWith('specialist-group-not-allowed')) return 'El grupo especialista solo se puede asignar al rol Especialista L2.';
			return p.detail || 'Hay datos no permitidos (rol o grupo). Revisa el formulario.';
		}
		return p.detail || porDefecto;
	},

	// Parámetros de GET /users: rol, solo activos, búsqueda y paginación del servidor
	rutaListado(pagina) {
		const params = {
			role: SelectRolFiltro.selectedOptionValue,
			is_active: SwSoloActivos.isSwitchedOn ? 'true' : '',
			search: (InputBuscar.text || '').trim(),
			page: pagina || TablaUsuarios.pageNo || 1,
			size: Math.min(Math.max(TablaUsuarios.pageSize || 10, 1), 100),
		};
		const q = Object.entries(params)
			.filter(([, v]) => v !== undefined && v !== null && v !== '')
			.map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
			.join('&');
		return q ? `?${q}` : '';
	},

	async cargar() {
		try {
			await this.ejecutar(ListarUsuariosQuery, { consulta: this.rutaListado() });
		} catch (e) {
			if (this.esCodigo(ListarUsuariosQuery, 401)) return Sesion.expulsar('Tu sesión expiró. Vuelve a iniciar sesión.');
			if (this.esCodigo(ListarUsuariosQuery, 400) && (TablaUsuarios.pageNo || 1) > 1) {
				resetWidget('TablaUsuarios', true);
				try { await this.ejecutar(ListarUsuariosQuery, { consulta: this.rutaListado(1) }); } catch (e2) { /* se informa abajo */ }
				return;
			}
			showAlert(this.mensajeError(ListarUsuariosQuery, 'No pudimos cargar los usuarios.'), 'error');
		}
	},

	async cambiarPagina() {
		await this.cargar();
	},

	async filtrar() {
		resetWidget('TablaUsuarios', true);
		await this.cargar();
	},

	// Búsqueda con debounce de 400 ms mientras se escribe
	buscar() {
		clearTimeout(this.ID_BUSQUEDA);
		setTimeout(() => this.filtrar(), 400, this.ID_BUSQUEDA);
	},

	filas() {
		return (ListarUsuariosQuery.data?.items || []).map(u => ({
			_id: u.id,
			_activo: u.is_active ? 'SI' : 'NO',
			'Nombre': u.full_name,
			'Correo': u.email,
			'Rol': this.ROLES[u.role] || u.role,
			'Departamento': u.department || '—',
			'Grupo': u.specialist_group ? (this.GRUPOS[u.specialist_group] || u.specialist_group) : '—',
			'Estado': u.is_active ? '● Activo' : (u.status === 'LOCKED' ? '⊘ Bloqueado' : '○ Inactivo'),
		}));
	},

	usuarioPorId(id) {
		return (ListarUsuariosQuery.data?.items || []).find(u => u.id === id);
	},

	mensajeVacio() {
		const filtros = SelectRolFiltro.selectedOptionValue || SwSoloActivos.isSwitchedOn || (InputBuscar.text || '').trim();
		return filtros ? 'Ningún usuario coincide con los filtros.' : 'Aún no hay usuarios en este espacio de trabajo.';
	},

	// ---------- Alta ----------
	abrirNuevo() {
		resetWidget('ModalNuevo', true);
		showModal('ModalNuevo');
	},

	validarNuevo() {
		const nombre = (InputNombreNuevo.text || '').trim();
		const correo = (InputCorreoNuevo.text || '').trim();
		const depto = (InputDeptoNuevo.text || '').trim();
		if (!nombre) return 'Escribe el nombre completo.';
		if (nombre.length > 150) return 'El nombre no puede superar los 150 caracteres.';
		if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(correo)) return 'Escribe un correo válido.';
		if (!SelectRolNuevo.selectedOptionValue) return 'Selecciona un rol.';
		if (!depto) return 'Escribe el departamento.';
		if (depto.length > 100) return 'El departamento no puede superar los 100 caracteres.';
		return null;
	},

	async crear() {
		if (this.guardando) return;
		const error = this.validarNuevo();
		if (error) {
			showAlert(error, 'warning');
			return;
		}
		const rol = SelectRolNuevo.selectedOptionValue;
		const datos = {
			full_name: InputNombreNuevo.text.trim(),
			email: InputCorreoNuevo.text.trim(),
			role: rol,
			department: InputDeptoNuevo.text.trim(),
		};
		// El grupo solo viaja si el rol es especialista
		if (rol === 'SPECIALIST_L2' && SelectGrupoNuevo.selectedOptionValue) {
			datos.specialist_group = SelectGrupoNuevo.selectedOptionValue;
		}
		this.guardando = true;
		try {
			await this.ejecutar(CrearUsuarioQuery, { datos });
		} catch (e) {
			if (this.esCodigo(CrearUsuarioQuery, 401)) return Sesion.expulsar('Tu sesión expiró. Vuelve a iniciar sesión.');
			showAlert(this.mensajeError(CrearUsuarioQuery, 'No pudimos crear el usuario.'), 'error');
			return;
		} finally {
			this.guardando = false;
		}
		// La contraseña temporal solo vive en CrearUsuarioQuery.data (memoria): nunca en appsmith.store
		closeModal('ModalNuevo');
		showModal('ModalClave');
		this.cargar();
	},

	// Borra la contraseña temporal de la memoria y cierra el cuadro. Se llama desde todos los caminos de cierre.
	cerrarClave() {
		CrearUsuarioQuery.clear();
		closeModal('ModalClave');
	},

	copiarClave() {
		const clave = CrearUsuarioQuery.data?.temporary_password;
		if (!clave) return;
		copyToClipboard(clave);
		showAlert('Contraseña copiada al portapapeles.', 'success');
	},

	// ---------- Edición ----------
	async abrirEditar(fila) {
		const u = this.usuarioPorId(fila._id);
		if (!u) return;
		await storeValue('usuarioEdicion', { id: u.id, full_name: u.full_name, email: u.email, role: u.role, department: u.department, specialist_group: u.specialist_group });
		resetWidget('ModalEditar', true);
		showModal('ModalEditar');
	},

	// Solo envía los campos que cambiaron
	cambiosEdicion() {
		const orig = appsmith.store.usuarioEdicion || {};
		const yo = this.esYo(orig.id);
		const rol = yo ? orig.role : SelectRolEditar.selectedOptionValue;
		const depto = (InputDeptoEditar.text || '').trim();
		const grupo = SelectGrupoEditar.selectedOptionValue || null;
		const cambios = {};
		if (rol !== orig.role) cambios.role = rol;
		if (depto !== (orig.department || '')) cambios.department = depto;
		if (rol === 'SPECIALIST_L2') {
			if (grupo !== (orig.specialist_group || null)) cambios.specialist_group = grupo;
		}
		return cambios;
	},

	async guardarEdicion() {
		if (this.guardando) return;
		const orig = appsmith.store.usuarioEdicion;
		if (!orig) return;
		const depto = (InputDeptoEditar.text || '').trim();
		if (!depto) {
			showAlert('Escribe el departamento.', 'warning');
			return;
		}
		if (depto.length > 100) {
			showAlert('El departamento no puede superar los 100 caracteres.', 'warning');
			return;
		}
		const cambios = this.cambiosEdicion();
		if (!Object.keys(cambios).length) {
			showAlert('No hay cambios para guardar.', 'info');
			return;
		}
		if (this.esYo(orig.id) && cambios.role) {
			showAlert('No puedes quitarte tu propio rol ni desactivarte.', 'warning');
			return;
		}
		this.guardando = true;
		try {
			await this.ejecutar(ActualizarUsuarioQuery, { id: orig.id, cambios });
		} catch (e) {
			if (this.esCodigo(ActualizarUsuarioQuery, 401)) return Sesion.expulsar('Tu sesión expiró. Vuelve a iniciar sesión.');
			showAlert(this.mensajeError(ActualizarUsuarioQuery, 'No pudimos guardar los cambios.'), 'error');
			if (this.esCodigo(ActualizarUsuarioQuery, 404)) {
				closeModal('ModalEditar');
				await this.cargar();
			}
			return;
		} finally {
			this.guardando = false;
		}
		closeModal('ModalEditar');
		showAlert('Usuario actualizado. Si cambió su rol, verá los permisos nuevos al volver a iniciar sesión.', 'success');
		await this.cargar();
	},

	// ---------- Activar / desactivar ----------
	async pedirCambioEstado(fila, activar) {
		const u = this.usuarioPorId(fila._id);
		if (!u) return;
		if (!activar && this.esYo(u.id)) {
			showAlert('No puedes quitarte tu propio rol ni desactivarte.', 'warning');
			return;
		}
		await storeValue('usuarioAccion', { id: u.id, full_name: u.full_name, email: u.email, activar });
		showModal('ModalConfirmar');
	},

	async confirmarCambioEstado() {
		if (this.guardando) return;
		const accion = appsmith.store.usuarioAccion;
		if (!accion) return;
		if (!accion.activar && this.esYo(accion.id)) {
			showAlert('No puedes quitarte tu propio rol ni desactivarte.', 'warning');
			return;
		}
		this.guardando = true;
		try {
			await this.ejecutar(ActualizarUsuarioQuery, { id: accion.id, cambios: { is_active: accion.activar } });
		} catch (e) {
			if (this.esCodigo(ActualizarUsuarioQuery, 401)) return Sesion.expulsar('Tu sesión expiró. Vuelve a iniciar sesión.');
			showAlert(this.mensajeError(ActualizarUsuarioQuery, 'No pudimos cambiar el estado del usuario.'), 'error');
			if (this.esCodigo(ActualizarUsuarioQuery, 404)) {
				closeModal('ModalConfirmar');
				await this.cargar();
			}
			return;
		} finally {
			this.guardando = false;
		}
		closeModal('ModalConfirmar');
		showAlert(accion.activar ? `${accion.full_name} fue activado.` : `${accion.full_name} fue desactivado.`, 'success');
		await this.cargar();
	},

	textoConfirmacion() {
		const a = appsmith.store.usuarioAccion;
		if (!a) return '';
		if (a.activar) {
			return `¿Activar la cuenta de ${a.full_name} (${a.email})? Podrá iniciar sesión de nuevo y quedará como no disponible hasta que se marque disponible.`;
		}
		return `¿Desactivar la cuenta de ${a.full_name} (${a.email})? No podrá iniciar sesión ni renovar su sesión. Su sesión actual puede seguir vigente hasta 30 minutos. Sus tickets asignados no se reasignan automáticamente.`;
	},
};