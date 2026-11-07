export default {
  ROL_DE_ESTA_APP: 'DASHBOARD',   // 'DASHBOARD' en la otra app

  async verificar() {
		if (appsmith.mode === 'EDIT') return;
    if (!appsmith.store.accessToken) {
      return this.expulsar('Inicia sesión para continuar.');
    }
    let me;
    try {
      me = await MeQuery.run();
    } catch (e) {
      try {
        const r = await RefreshQuery.run();
        await storeValue('accessToken', r.access_token);
        me = await MeQuery.run();
      } catch (e2) {
        return this.expulsar('Tu sesión expiró. Vuelve a iniciar sesión.');
      }
    }
    const esColaborador = me.role === 'COLLABORATOR';
    const permitido = this.ROL_DE_ESTA_APP === 'PORTAL' ? esColaborador : !esColaborador;
    if (!permitido) {
      return this.expulsar('Tu cuenta no tiene acceso a esta aplicación.');
    }
    await storeValue('user', me);
  },

  async expulsar(mensaje) {
    clearStore();
    showAlert(mensaje, 'warning');
    navigateTo('Login');
  },

  cerrarSesion() {
    clearStore();
    navigateTo('Login');
  }
}