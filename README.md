# SACS Embedded Checkout Widget

Widget de checkout embebido para SACS (Sistema Avanzado de Comunicación Social). Plugin JavaScript standalone que permite integrar un carrito de compras completo y proceso de checkout en cualquier sitio web.

## 🚀 Características

- **Integración Simple**: Un solo script para agregar checkout completo a tu sitio
- **Carrito de Compras**: Gestión completa de productos y cantidades
- **Proceso de Checkout**: Flujo de 3 pasos (Carrito → Pago → Confirmación)
- **Pagos con Stripe**: Integración con Stripe Connect para procesamiento seguro
- **Personalizable**: Colores y estilos configurables
- **Responsive**: Diseño adaptable a todos los dispositivos

## 📦 Instalación

### Opción 1: CDN (Recomendado)

```html
<!-- Cargar el widget desde CDN -->
<script src="https://cdn.jsdelivr.net/gh/sacscloud/sacs-checkout/checkout-widget.js"></script>

<!-- Contenedor para el botón de checkout -->
<div id="sacs-checkout-button"></div>

<!-- Inicializar el widget (configuración minimalista) -->
<script>
  sacsCheckout.init({
    accountId: 'TU_ACCOUNT_ID'
  });
</script>
```

### Opción 2: Local

1. Descarga `checkout-widget.js`
2. Inclúyelo en tu HTML:

```html
<script src="./checkout-widget.js"></script>
```

## 🎯 Uso

### Inicialización Básica

```javascript
// Cargar configuración desde MongoDB
await SacsCheckout.init({
  accountId: 'TU_ACCOUNT_ID'
});
```

### Inicialización con Productos Personalizados

```javascript
await SacsCheckout.init({
  accountId: 'TU_ACCOUNT_ID',
  products: [
    {
      id: '123',
      name: 'Producto 1',
      price: 29.99,
      image: 'https://ejemplo.com/producto1.jpg',
      description: 'Descripción del producto'
    },
    {
      id: '456',
      name: 'Producto 2',
      price: 49.99,
      image: 'https://ejemplo.com/producto2.jpg'
    }
  ],
  primaryColor: '#4F46E5',
  textColor: '#FFFFFF',
  accentColor: '#6366F1'
});
```

### Personalización de Colores

```javascript
await SacsCheckout.init({
  accountId: 'TU_ACCOUNT_ID',
  primaryColor: '#1F2937',   // Color principal del widget
  textColor: '#FFFFFF',      // Color del texto en botones
  accentColor: '#000000'     // Color de acentos y enlaces
});
```

## 🔧 Configuración

### Parámetros de Inicialización

| Parámetro | Tipo | Requerido | Descripción |
|-----------|------|-----------|-------------|
| `accountId` | string | ✅ | ID de tu cuenta SACS |
| `products` | array | ❌ | Array de productos (se carga desde MongoDB si no se especifica) |
| `primaryColor` | string | ❌ | Color principal (por defecto: `#1F2937`) |
| `textColor` | string | ❌ | Color del texto (por defecto: `#FFFFFF`) |
| `accentColor` | string | ❌ | Color de acentos (por defecto: `#000000`) |

### Estructura de Producto

```javascript
{
  id: 'string',              // ID único del producto
  name: 'string',            // Nombre del producto
  price: number,             // Precio en la moneda configurada
  image: 'string',           // URL de la imagen
  description: 'string'      // Descripción opcional
}
```

## 🎨 Personalización

El widget se puede personalizar mediante CSS. Todas las clases comienzan con el prefijo `sacs-checkout-`:

```css
/* Personalizar el botón principal */
.sacs-checkout-button {
  border-radius: 8px !important;
  font-size: 18px !important;
}

/* Personalizar el modal */
.sacs-checkout-overlay {
  backdrop-filter: blur(5px);
}
```

## 🔐 Seguridad

- Todos los pagos se procesan de forma segura a través de Stripe
- La información sensible nunca se almacena en el cliente
- Conexión HTTPS obligatoria en producción
- Validación de datos en servidor

## 🌐 APIs Utilizadas

- **SACS API**: `https://sacs-api-819604817289.us-central1.run.app/v1`
- **Stripe**: Integración con Stripe Connect

## 📋 Requisitos

- Cuenta activa en SACS
- Configuración de Stripe Connect
- Navegador con soporte para ES6+
- HTTPS (requerido para Stripe en producción)

## 🛠️ Desarrollo

### Estructura del Proyecto

```
sacs-cdn/
├── checkout-widget.js    # Widget principal
├── .github/
│   └── workflows/       # GitHub Actions
└── README.md           # Este archivo
```

### Versión

**v1.0.0** - Widget de checkout embebido

## 📝 Flujo de Checkout

1. **Carrito**: El usuario revisa los productos y cantidades
2. **Información**: El usuario ingresa datos de envío y pago
3. **Confirmación**: Se procesa el pago y se muestra la confirmación

## 🤝 Soporte

Para soporte técnico o consultas sobre la integración, contacta al equipo de SACS.

## 📄 Licencia

Propietario - SACS

---

Desarrollado con ❤️ para SACS
