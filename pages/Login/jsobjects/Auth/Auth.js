export default {
  ROL_DE_ESTA_APP: 'DASHBOARD',   
  PORTAL_URL: 'https://app.appsmith.com/app/tracehelp-portal/login-6aeb2fec668f2711775d68eb',             
  DASHBOARD_URL: 'https://app.appsmith.com/app/tracehelp-dashboard/login-6aebd3a008bd09fa65dae85a',

  perteneceAEstaApp(rol) {
    const esColaborador = rol === 'COLLABORATOR';
    return this.ROL_DE_ESTA_APP === 'PORTAL' ? esColaborador : !esColaborador;
  },

   async alCargar() {
     if (appsmith.mode === 'EDIT') return;
     if (appsmith.store.accessToken) {
       navigateTo('Inicio');
     }
   },

  async iniciarSesion() {
    const email = (InputEmail.text || '').trim();
    if (!email || !InputPassword.text) {
      showAlert('Ingresa tu correo y tu contraseña.', 'warning');
      return;
    }

    let res;
    try {
      res = await LoginQuery.run();
    } catch (e) {
      const detalle = LoginQuery.data && LoginQuery.data.detail;
      showAlert(detalle || 'No pudimos conectar con el servidor. Intenta de nuevo en unos segundos.', 'error');
      return;
    }

    if (!this.perteneceAEstaApp(res.user.role)) {
      const destino = this.ROL_DE_ESTA_APP === 'PORTAL' ? this.DASHBOARD_URL : this.PORTAL_URL;
      const nombre = this.ROL_DE_ESTA_APP === 'PORTAL' ? 'Dashboard de TI' : 'Portal de colaboradores';
      if (!destino) {
        showAlert(`Tu cuenta debe ingresar por el ${nombre}, que aún no está configurado.`, 'warning');
        return;
      }
      showAlert(`Tu cuenta ingresa por el ${nombre}. Te estamos redirigiendo.`, 'info');
      navigateTo(destino, { email: email }, 'SAME_WINDOW');
      return;
    }

    await storeValue('accessToken', res.access_token);
    await storeValue('refreshToken', res.refresh_token);
    await storeValue('user', res.user);
    navigateTo('Inicio');
  }
}