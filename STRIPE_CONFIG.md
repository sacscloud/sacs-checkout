# 🔧 Configuración de Stripe - Ecosistema SACS

Documentación completa de todas las configuraciones de Stripe en los proyectos SACS.
Esta guía te ayudará a actualizar keys, Client IDs y versiones en el futuro.

---

## 📋 Índice

1. [Resumen Ejecutivo](#resumen-ejecutivo)
2. [sacs-checkout (sacs_cdn)](#1-sacs-checkout-sacs_cdn)
3. [sacs3 (Backend Principal)](#2-sacs3-backend-principal)
4. [fashion-forward-catalogue](#3-fashion-forward-catalogue)
5. [Proceso de Actualización](#proceso-de-actualización)
6. [Checklist de Deploy](#checklist-de-deploy)

---

## Resumen Ejecutivo

### 🔑 Keys de Stripe Actuales (Producción)

| Key Type | Valor | Ubicación |
|----------|-------|-----------|
| **Publishable Key** | `pk_live_l7yPQkiwvj4tLItBtOGu3SeY00hN8yONF5` | sacs-checkout, fashion-forward-catalogue |
| **Client ID** | `ca_F7EX999UrPtPK02a19N4VGJXfGODEwEH` | sacs3 |

### 🏗️ Arquitectura

- **Stripe Connect**: Usamos Direct Charges (el dinero va 100% a las cuentas conectadas)
- **Platform Account**: SACSCLOUD
- **Publishable Key**: Se usa en el frontend para inicializar Stripe
- **Client ID**: Se usa para el flujo OAuth de conexión de cuentas

---

## 1. sacs-checkout (sacs_cdn)

### 📦 Repositorio
- **GitHub**: `sacscloud/sacs-checkout` (antes `sacscloud/sacs-cdn`)
- **Ruta Local**: `E:\www\sacs_cdn`

### 🔧 Archivo a modificar

**Archivo:** `checkout-widget.js`
**Línea:** 14

```javascript
// Stripe Platform Publishable Key - Direct Charges con Stripe Connect
const STRIPE_PUBLISHABLE_KEY = 'pk_live_l7yPQkiwvj4tLItBtOGu3SeY00hN8yONF5';
```

### 📝 Cómo actualizar:

1. Editar `checkout-widget.js` línea 14
2. Reemplazar la publishable key
3. Actualizar el comentario de versión si es necesario (línea 4)
4. Commit y push a GitHub
5. **IMPORTANTE**: Crear/actualizar tags para que el CDN lo tome

### 🏷️ Versionado y Tags

**Versión actual del código:** `1.5.0`

**Tags existentes:**
- `v1.5.0` - Tag de versión semántica
- `v6` - Tag legacy (NO USAR)
- `latest` - Tag que apunta siempre a la última versión

**Para actualizar el tag latest:**
```bash
cd E:\www\sacs_cdn
git tag -f latest
git push origin latest --force
```

### 🌐 CDN URL

El widget se carga desde:
```
https://cdn.jsdelivr.net/gh/sacscloud/sacs-checkout@latest/checkout-widget.js
```

**Nota:** jsDelivr puede tomar hasta 12 horas en actualizar el cache. Para forzar actualización usar:
```
https://purge.jsdelivr.net/gh/sacscloud/sacs-checkout@latest/checkout-widget.js
```

---

## 2. sacs3 (Backend Principal)

### 📦 Repositorio
- **GitHub**: `sacscloud/sacs3`
- **Ruta Local**: `E:\www\sacs3`

### 🔧 Archivos a modificar

#### A) Client ID de Stripe Connect

**Archivo:** `src/elem/lateral/lateral.js`
**Línea:** 3095

```javascript
stripeClientId: {
    type: String,
    value: 'ca_F7EX999UrPtPK02a19N4VGJXfGODEwEH'  // ← Client ID de producción
}
```

**Cuándo actualizar:**
- Cuando cambies de cuenta de Stripe
- Cuando necesites alternar entre test y producción
- Si Stripe genera un nuevo Client ID

**Dónde obtener el Client ID:**
1. Dashboard de Stripe: https://dashboard.stripe.com/settings/applications
2. Sección "OAuth Settings"
3. Copiar "Client ID" (Live mode para producción, Test mode para desarrollo)

---

#### B) URL del Widget (Versión del CDN)

**Archivos:**
- `src/elem/lateral/menu-lateral.html` (línea 10896)
- `src/elem/lateral/lateral.js` (línea 14215)

**menu-lateral.html:**
```html
<pre id="ecommerceEmbedCode">
&lt;script src="https://cdn.jsdelivr.net/gh/sacscloud/sacs-checkout@latest/checkout-widget.js"&gt;&lt;/script&gt;
&lt;div id="sacs-checkout-button"&gt;&lt;/div&gt;
&lt;script&gt;
  sacsCheckout.init({ accountId: '[[session.account]]' });
&lt;/script&gt;
</pre>
```

**lateral.js:**
```javascript
if (!window.sacsCheckout) {
    var script = document.createElement('script');
    script.src = 'https://cdn.jsdelivr.net/gh/sacscloud/sacs-checkout@latest/checkout-widget.js';
    // ...
}
```

**Cuándo actualizar:**
- Si cambias la estrategia de versionado (ej: de `@latest` a `@v2.0.0`)
- Si mueves el widget a otro CDN
- Si cambias el nombre del repositorio

**⚠️ IMPORTANTE:** Usar `@latest` asegura que siempre se carga la versión más reciente sin necesidad de actualizar sacs3.

---

## 3. fashion-forward-catalogue

### 📦 Repositorio
- **GitHub**: Repositorio del catálogo
- **Ruta Local**: `E:\www\fashion-forward-catalogue`
- **Deploy**: Vercel

### 🔧 Configuración

**Variables de entorno (.env.local):**

Archivo: `.env.local` (NO se sube a GitHub, está en .gitignore)

```bash
# Stripe Platform Publishable Key
# Esta es la key de la plataforma SACSCLOUD, se usa con stripeAccount para Direct Charges
VITE_STRIPE_PUBLISHABLE_KEY=pk_live_l7yPQkiwvj4tLItBtOGu3SeY00hN8yONF5
```

### 📝 Cómo actualizar:

#### Para desarrollo local:
1. Editar `.env.local`
2. Reemplazar el valor de `VITE_STRIPE_PUBLISHABLE_KEY`
3. **NO hacer commit** (el archivo está en .gitignore)

#### Para producción (Vercel):
1. Ir a Vercel Dashboard del proyecto
2. Settings → Environment Variables
3. Editar `VITE_STRIPE_PUBLISHABLE_KEY`
4. Guardar
5. **Redeploy** el proyecto para aplicar cambios

**Archivo de ejemplo (.env.example):**

Si quieres documentar la key en el repo (aunque sea pública):
```bash
# .env.example
VITE_STRIPE_PUBLISHABLE_KEY=pk_live_l7yPQkiwvj4tLItBtOGu3SeY00hN8yONF5
```

### 📂 Archivos donde se usa:

**Archivo:** `src/components/StripePaymentModal.tsx`
**Línea:** 23

```javascript
// IMPORTANTE: Esta es la Publishable Key de la PLATAFORMA SACSCLOUD
const STRIPE_PUBLISHABLE_KEY = import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY;
```

**Archivo:** `src/services/stripeService.ts`

Servicio que maneja la creación de Payment Intents y conexión con backend.

---

## Proceso de Actualización

### 🔄 Actualizar Publishable Key (cambio a producción o nueva key)

1. **sacs-checkout**
   ```bash
   cd E:\www\sacs_cdn
   # Editar checkout-widget.js línea 14
   git add checkout-widget.js
   git commit -m "🔧 config(stripe): Actualizar publishable key a NUEVA_KEY"
   git push
   git tag -f latest
   git push origin latest --force
   ```

2. **fashion-forward-catalogue**
   - Local: Editar `.env.local`
   - Vercel: Settings → Environment Variables → Actualizar → Redeploy

3. **sacs3** (NO requiere cambios si solo cambias la publishable key)

---

### 🔄 Actualizar Client ID (cambio de cuenta Stripe o test/producción)

1. **sacs3**
   ```bash
   cd E:\www\sacs3
   # Editar src/elem/lateral/lateral.js línea 3095
   git add src/elem/lateral/lateral.js
   git commit -m "🔧 config(stripe): Actualizar Client ID a NUEVO_CLIENT_ID"
   git pull  # Siempre pull antes de push
   git push
   ```

2. **Otros proyectos:** NO requieren cambios

---

### 🔄 Actualizar versión del widget

1. **sacs-checkout**
   ```bash
   cd E:\www\sacs_cdn
   # Editar checkout-widget.js línea 4 (comentario de versión)
   # Ejemplo: Versión: 1.6.0 - Nueva feature
   git add checkout-widget.js
   git commit -m "🔖 version: Actualizar a v1.6.0"
   git push

   # Crear tag de versión
   git tag v1.6.0
   git push origin v1.6.0

   # Actualizar tag latest
   git tag -f latest
   git push origin latest --force
   ```

2. **sacs3** (NO requiere cambios si usa `@latest`)

---

## Checklist de Deploy

### ✅ Checklist: Cambio de Test a Producción

- [ ] **sacs-checkout**
  - [ ] Actualizar `STRIPE_PUBLISHABLE_KEY` a `pk_live_...`
  - [ ] Commit y push
  - [ ] Actualizar tag `latest`
  - [ ] Purgar cache de jsDelivr (opcional)

- [ ] **sacs3**
  - [ ] Actualizar `stripeClientId` a Client ID de producción
  - [ ] Pull antes de push para evitar conflictos
  - [ ] Push a GitHub

- [ ] **fashion-forward-catalogue**
  - [ ] Actualizar `.env.local` para desarrollo
  - [ ] Actualizar variable en Vercel
  - [ ] Redeploy en Vercel

- [ ] **Verificación**
  - [ ] Abrir sacs3 → Mi Cuenta → Conectar con Stripe
  - [ ] Verificar que NO diga "cuenta de prueba"
  - [ ] Probar el checkout widget en test.html local
  - [ ] Probar el catálogo en Vercel

---

### ✅ Checklist: Nueva versión del widget

- [ ] **Desarrollar cambios en sacs-checkout**
  - [ ] Hacer cambios en `checkout-widget.js`
  - [ ] Probar localmente con `test.html`
  - [ ] Actualizar comentario de versión (línea 4)

- [ ] **Versionado**
  - [ ] Commit con mensaje descriptivo
  - [ ] Crear tag semántico: `git tag v1.X.0`
  - [ ] Push tag: `git push origin v1.X.0`
  - [ ] Actualizar tag latest: `git tag -f latest && git push origin latest --force`

- [ ] **Verificación**
  - [ ] Esperar ~5 minutos para que jsDelivr actualice
  - [ ] Probar carga desde CDN
  - [ ] Verificar que sacs3 cargue la nueva versión

---

## 📚 Recursos Útiles

### Stripe Dashboard
- **Producción**: https://dashboard.stripe.com (toggle a "Live mode")
- **Test**: https://dashboard.stripe.com (toggle a "Test mode")
- **OAuth Settings**: https://dashboard.stripe.com/settings/applications
- **Keys**: https://dashboard.stripe.com/apikeys

### jsDelivr
- **Purge Cache**: https://purge.jsdelivr.net/gh/sacscloud/sacs-checkout@latest/checkout-widget.js
- **CDN Status**: https://www.jsdelivr.com/github

### Repositorios
- **sacs-checkout**: https://github.com/sacscloud/sacs-checkout
- **sacs3**: https://github.com/sacscloud/sacs3

---

## 🔐 Seguridad

### ⚠️ Keys Públicas vs Privadas

**Publishable Key (`pk_`)**:
- ✅ Es PÚBLICA, puede estar en código frontend
- ✅ Puede subirse a GitHub
- ✅ Se usa para inicializar Stripe en el cliente

**Secret Key (`sk_`)**:
- ❌ NUNCA debe estar en código frontend
- ❌ NUNCA debe subirse a GitHub
- ❌ Solo debe estar en el backend/servidor

**Client ID (`ca_`)**:
- ⚠️ Es semi-público (aparece en URLs OAuth)
- ✅ Puede estar en código frontend
- ✅ Se usa para el flujo OAuth

### 🔒 Best Practices

1. **NUNCA** subir `.env.local` a GitHub (está en .gitignore)
2. **SIEMPRE** usar variables de entorno en producción (Vercel, etc.)
3. **REVISAR** que las keys de test no queden en producción
4. **DOCUMENTAR** cambios de keys en commits para trazabilidad

---

## 🆘 Troubleshooting

### Problema: "Cuenta de prueba" al conectar Stripe en sacs3

**Causa**: El Client ID es de test mode

**Solución**:
1. Ir a Stripe Dashboard → Live mode
2. Settings → Applications → copiar Client ID
3. Actualizar en `src/elem/lateral/lateral.js` línea 3095
4. Push a GitHub

---

### Problema: Widget no carga la última versión

**Causa**: Cache de jsDelivr

**Solución**:
1. Verificar que el tag `latest` esté actualizado:
   ```bash
   cd E:\www\sacs_cdn
   git tag -f latest
   git push origin latest --force
   ```
2. Purgar cache: https://purge.jsdelivr.net/gh/sacscloud/sacs-checkout@latest/checkout-widget.js
3. Esperar 5-10 minutos

---

### Problema: Pagos fallan en fashion-forward-catalogue

**Causa**: Variable de entorno no configurada en Vercel

**Solución**:
1. Vercel Dashboard → Settings → Environment Variables
2. Verificar que `VITE_STRIPE_PUBLISHABLE_KEY` exista
3. Verificar que tenga el valor correcto (`pk_live_...`)
4. Redeploy el proyecto

---

## 📅 Historial de Cambios

### 2025-01-20
- ✅ Actualizado Publishable Key a producción en sacs-checkout
- ✅ Actualizado Client ID a producción en sacs3
- ✅ Configurado `@latest` en lugar de `@v6` en sacs3
- ✅ Creado tag `latest` en sacs-checkout
- ✅ Configurado variable de entorno en Vercel (fashion-forward-catalogue)

---

## 👤 Contacto

Para dudas o problemas con la configuración de Stripe, consultar esta documentación primero.

**Repositorio de documentación**: `E:\www\sacs_cdn\STRIPE_CONFIG.md`

---

*Última actualización: 2025-01-20*
*Generado con ❤️ por Claude Code*
