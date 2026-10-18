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
await sacsCheckout.init({
  accountId: 'TU_ACCOUNT_ID'
});
```

### Usar Botón Nativo del CMS (Shopify, Wix, Squarespace, etc.)

Si prefieres usar el botón nativo de tu CMS en lugar del botón generado por SACS:

```html
<!-- Tu botón nativo del CMS -->
<button id="mi-boton-comprar" class="tu-clase-css">Comprar Ahora</button>

<script src="https://cdn.jsdelivr.net/gh/sacscloud/sacs-checkout@master/checkout-widget.js"></script>
<script>
  // Inicializar SIN crear botón (renderButton: false)
  var miCheckout;

  sacsCheckout.init({
    accountId: 'TU_ACCOUNT_ID',
    configId: 'TU_CONFIG_ID',
    renderButton: false  // ← No crea botón, usamos el del CMS
  }).then(function(instance) {
    miCheckout = instance;
  });

  // Conectar tu botón del CMS al checkout
  document.getElementById('mi-boton-comprar').onclick = function() {
    miCheckout.open();
  };
</script>
```

**Alternativa más simple** usando el método global:

```html
<button onclick="sacsCheckout.open('mi-checkout')">Comprar</button>

<script>
  sacsCheckout.init({
    accountId: 'TU_ACCOUNT_ID',
    configId: 'mi-checkout',  // ← Este ID se usa para open()
    renderButton: false
  });
</script>
```

### Múltiples Botones en la Misma Página

Para tener varios botones de checkout en diferentes lugares de tu sitio:

```html
<!-- Botón 1: Producto A -->
<div id="checkout-producto-a"></div>

<!-- Botón 2: Producto B (en otra sección) -->
<div id="checkout-producto-b"></div>

<script src="https://cdn.jsdelivr.net/gh/sacscloud/sacs-checkout@master/checkout-widget.js"></script>
<script>
  // IMPORTANTE: Usar IDs únicos con containerId
  sacsCheckout.init({
    accountId: 'TU_ACCOUNT_ID',
    configId: 'config-producto-a',
    containerId: 'checkout-producto-a'  // ← ID único
  });

  sacsCheckout.init({
    accountId: 'TU_ACCOUNT_ID',
    configId: 'config-producto-b',
    containerId: 'checkout-producto-b'  // ← ID único diferente
  });
</script>
```

> ⚠️ **Importante**: NO uses el mismo ID (`sacs-checkout-button`) para múltiples contenedores. Siempre usa `containerId` con valores únicos.

### Inicialización con Productos Personalizados

```javascript
await sacsCheckout.init({
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
await sacsCheckout.init({
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
| `configId` | string | ❌ | ID de la configuración de ecommerce (creada en SACS) |
| `containerId` | string | ❌ | ID único del contenedor HTML (para múltiples botones) |
| `renderButton` | boolean | ❌ | Si es `false`, no crea botón (default: `true`) |
| `products` | array | ❌ | Array de productos (se carga desde MongoDB si no se especifica) |
| `primaryColor` | string | ❌ | Color principal (por defecto: `#1F2937`) |
| `textColor` | string | ❌ | Color del texto (por defecto: `#FFFFFF`) |
| `accentColor` | string | ❌ | Color de acentos (por defecto: `#000000`) |

### Métodos Disponibles

| Método | Descripción |
|--------|-------------|
| `sacsCheckout.init(options)` | Inicializa una instancia y retorna una Promise |
| `sacsCheckout.open(id)` | Abre el drawer de una instancia por su `containerId` o `configId` |
| `sacsCheckout.getInstance(id)` | Obtiene una instancia por su ID |
| `sacsCheckout.listInstances()` | Lista todos los IDs de instancias activas |
| `instancia.open()` | Abre el drawer de una instancia específica |

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

- **SACS API**: `https://api.sacscloud.com/v1`
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

**v1.9.0** - Soporte para botones nativos de CMS + múltiples instancias mejoradas
- Nueva opción `renderButton: false` para usar botones del CMS
- Nuevo método `sacsCheckout.open(id)` para abrir drawer desde cualquier lugar
- Soporte mejorado para múltiples instancias con `containerId`
- Documentación de API completa

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
