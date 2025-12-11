/**
 * SACS Embedded Checkout Widget
 * Plugin standalone para integrar carrito + checkout en cualquier sitio web
 * Versión: 1.9.8 - Permitir cantidad 0 en productos del carrito
 *
 * Nuevas opciones:
 * - renderButton: false → No crea botón, permite usar botón nativo del CMS
 * - containerId: 'mi-id' → ID único para múltiples botones en la misma página
 *
 * Ejemplo con botón nativo del CMS:
 *   var checkout = await sacsCheckout.init({ accountId: 'xxx', renderButton: false });
 *   document.getElementById('mi-boton').onclick = () => checkout.open();
 */

(function(window) {
    'use strict';

    // ====== CONFIGURACIÓN ======
    const SACS_API_URL = 'https://api.sacscloud.com/v1';

    // ====== STRIPE - LLAVES ======
    // Stripe Platform Publishable Keys - Direct Charges con Stripe Connect
    // El modo (test/producción) se lee de la configuración de la cuenta en MongoDB
    const STRIPE_KEYS = {
        test: 'pk_test_51SOJtVIDcKiybAAm47MUPAZ2rWptm9y0ffR0cg29PFORoml4pw1zOJjgQ3up5YvqabN0jWDW2ii2s1cNEfiFbhoV00xvSrkbuB',
        live: 'pk_live_l7yPQkiwvj4tLItBtOGu3SeY00hN8yONF5'
    };

    class SacsCheckout {
        constructor() {
            // Generar ID único para esta instancia
            this.instanceId = 'sacs-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9);
            this.containerId = null; // Se establecerá en init()

            this.config = {
                accountId: null,
                configId: null,
                products: [],
                drawerStyles: {
                    backgroundColor: '#FFFFFF',
                    primaryTextColor: '#000000',
                    secondaryTextColor: '#6B7280',
                    buttonBgColor: '#000000',
                    buttonTextColor: '#FFFFFF',
                    buttonHoverColor: '#374151'
                },
                checkoutButtonStyles: {
                    text: 'Comprar Ahora',
                    bgColor: '#000000',
                    textColor: '#FFFFFF',
                    size: 'medium'
                }
            };
            this.cart = [];
            this.isOpen = false;
            this.currentStep = 1; // 1: Carrito, 2: Pago, 3: Firma (condicional), 4: Confirmar
            this.stripe = null;
            this.cardElement = null;
            this.customerInfo = {
                correo: '',
                nombre: '',
                direccion: '',
                ciudad: '',
                codigoPostal: ''
            };
            this.orderId = null;
            this.paymentError = null; // Para almacenar errores cuando el pago es exitoso pero falla el pedido

            // Variables para manejo de firma
            this.isDrawing = false;
            this.lastX = 0;
            this.lastY = 0;
            this.firmaDibujada = false;
            this.firmaBase64 = null;
            this.termsAccepted = false; // Checkbox de términos aceptados
            this.paymentIntentId = null;
            this.paymentTotal = 0;
        }

        findAvailableContainer() {
            // Buscar contenedores con el ID sacs-checkout-button
            const containers = document.querySelectorAll('[id="sacs-checkout-button"]');

            if (containers.length === 0) {
                console.error('❌ No se encontró ningún contenedor con id="sacs-checkout-button"');
                return 'sacs-checkout-button';
            }

            // Buscar el primer contenedor que no tenga un botón ya renderizado
            for (let container of containers) {
                if (container.children.length === 0) {
                    return container.id;
                }
            }

            // Si todos están ocupados, usar el primero de todos modos
            return containers[0].id;
        }

        async init(options) {
            console.log('🔧 Init widget con opciones:', options);

            // Establecer containerId (usar el proporcionado o buscar el siguiente disponible)
            this.containerId = options.containerId || this.findAvailableContainer();
            console.log('📦 Usando containerId:', this.containerId);

            // Guardar accountId y configId
            this.config.accountId = options.accountId;
            this.config.configId = options.configId || null;

            // PASO 1: Cargar configuraciones desde MongoDB (si hay accountId)
            if (options.accountId) {
                console.log('📡 Cargando Stripe config...');
                await this.loadStripeConfig(options.accountId);

                console.log('📡 Cargando Account Defaults (almacén, sucursal, etc.)...');
                await this.loadAccountDefaults(options.accountId);

                console.log('📡 Cargando eCommerce config (productos, colores, etc.)...');
                await this.loadEcommerceConfig(options.accountId, options.configId);

                console.log('📡 Cargando Plantilla de Contratos...');
                await this.loadPlantillaContratos(options.accountId);
            }

            // PASO 2: Aplicar opciones del código embed (override MongoDB)
            // Prioridad: código embed > MongoDB > default
            if (options.products) this.config.products = options.products;

            // Drawer styles (mantener retrocompatibilidad)
            if (options.drawerStyles) {
                this.config.drawerStyles = {...this.config.drawerStyles, ...options.drawerStyles};
            }
            if (options.primaryColor) this.config.drawerStyles.backgroundColor = options.primaryColor;
            if (options.textColor) this.config.drawerStyles.primaryTextColor = options.textColor;
            if (options.secondaryTextColor) this.config.drawerStyles.secondaryTextColor = options.secondaryTextColor;

            // Checkout button styles (mantener retrocompatibilidad)
            if (options.checkoutButtonStyles) {
                this.config.checkoutButtonStyles = {...this.config.checkoutButtonStyles, ...options.checkoutButtonStyles};
            }
            if (options.buttonText) this.config.checkoutButtonStyles.text = options.buttonText;
            if (options.buttonBgColor) this.config.checkoutButtonStyles.bgColor = options.buttonBgColor;
            if (options.buttonTextColor) this.config.checkoutButtonStyles.textColor = options.buttonTextColor;
            if (options.buttonSize) this.config.checkoutButtonStyles.size = options.buttonSize;

            console.log('📦 Productos cargados:', this.config.products);
            console.log('🎨 Estilos drawer:', this.config.drawerStyles);
            console.log('🎨 Estilos botón checkout:', this.config.checkoutButtonStyles);

            // Inicializar carrito con productos preconfigurados
            // Usar cantidadDefault del producto si está configurada, sino 1
            this.cart = this.config.products.map(product => ({
                ...product,
                quantity: product.cantidadDefault || 1
            }));

            // Cargar Stripe.js (esperar a que termine)
            await this.loadStripe();

            // Inyectar estilos (después de tener todos los colores)
            this.injectStyles();

            // Renderizar botón solo si renderButton !== false
            // Si es false, el usuario usará su propio botón del CMS y llamará a open() manualmente
            if (options.renderButton !== false) {
                this.renderButton();
            } else {
                console.log('ℹ️ renderButton: false - No se crea botón. Usar instancia.open() para abrir el drawer.');
            }
        }

        async loadEcommerceConfig(accountId, configId = null) {
            const API_URL = 'https://sacs-api-819604817289.us-central1.run.app/v1';

            try {
                // Construir el filtro: si hay configId, filtrar por id, sino solo por account
                const matchFilter = configId
                    ? { account: accountId, id: configId }
                    : { account: accountId };

                console.log('🔍 Buscando ecommerce config con filtro:', matchFilter);

                const response = await fetch(`${API_URL}/rest/${accountId}/ecommerceconfig/aggregate`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        pipeline: [
                            { $match: matchFilter },
                            { $limit: 1 }
                        ]
                    })
                });

                const result = await response.json();

                if (result.success && Array.isArray(result.data) && result.data.length > 0) {
                    const config = result.data[0];

                    // Guardar productos completos tal como vienen de MongoDB
                    this.config.products = await Promise.all((config.products || []).map(async p => {
                        // Solo cargar la imagen, mantener TODO lo demás intacto
                        const imageUrl = await this.loadProductImage(accountId, p.fid, p.tipo);

                        // Agregar la imagen cargada al producto sin modificar nada más
                        return {
                            ...p,
                            imageUrl: imageUrl // Agregar imagen cargada
                        };
                    }));

                    // Cargar estilos del drawer
                    if (config.drawerStyles) {
                        this.config.drawerStyles = {...this.config.drawerStyles, ...config.drawerStyles};
                    }

                    // Cargar estilos del botón de checkout
                    if (config.checkoutButtonStyles) {
                        this.config.checkoutButtonStyles = {...this.config.checkoutButtonStyles, ...config.checkoutButtonStyles};
                    }

                    console.log('✓ Configuración de eCommerce cargada desde MongoDB');
                }
            } catch (error) {
                console.error('Error cargando configuración de eCommerce:', error);
            }
        }

        async loadStripeConfig(accountId) {
            const API_URL = 'https://sacs-api-819604817289.us-central1.run.app/v1';

            try {
                const response = await fetch(`${API_URL}/rest/${accountId}/stripe_config/aggregate`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        pipeline: [
                            { $match: { _id: 'stripe' } },
                            { $limit: 1 }
                        ]
                    })
                });

                const result = await response.json();

                if (result.success && Array.isArray(result.data) && result.data.length > 0) {
                    const stripeConfig = result.data[0];
                    this.config.stripeTestMode = stripeConfig.stripeTestMode || false;

                    // Usar el accountId según el modo (nuevos campos separados)
                    // Fallback al campo viejo stripeAccountId para compatibilidad
                    this.config.stripeAccountId = this.config.stripeTestMode
                        ? (stripeConfig.stripeAccountIdTest || stripeConfig.stripeAccountId)
                        : (stripeConfig.stripeAccountIdLive || stripeConfig.stripeAccountId);

                    console.log('✓ Stripe Account ID:', this.config.stripeAccountId);
                    console.log('✓ Stripe Test Mode:', this.config.stripeTestMode);
                } else {
                    console.error('No se encontró configuración de Stripe para esta cuenta');
                }
            } catch (error) {
                console.error('Error cargando configuración de Stripe:', error);
            }
        }

        async loadAccountDefaults(accountId) {
            const API_URL = 'https://sacs-api-819604817289.us-central1.run.app/v1';

            try {
                // Los defaults están en store_config de admin con filtro por account
                const response = await fetch(`${API_URL}/rest/admin/store_config?limit=1&account=${accountId}&isActive=true`, {
                    method: 'GET',
                    headers: { 'Content-Type': 'application/json' }
                });

                const result = await response.json();

                if (result.success && Array.isArray(result.data) && result.data.length > 0) {
                    const config = result.data[0];

                    if (config && config.defaults) {
                        this.config.accountDefaults = config.defaults;
                        this.config.branding = config.branding || {};
                        console.log('✓ Account Defaults cargados:', config.defaults);
                        console.log('✓ Branding cargado:', config.branding);
                    } else {
                        throw new Error('No se encontró configuración de defaults para esta cuenta');
                    }
                } else {
                    throw new Error('Error al obtener store_config');
                }
            } catch (error) {
                console.error('Error cargando account defaults:', error);
                throw error;
            }
        }

        async loadPlantillaContratos(accountId) {
            const API_URL = 'https://sacs-api-819604817289.us-central1.run.app/v1';

            try {
                const response = await fetch(`${API_URL}/rest/${accountId}/plantillas_contratos/aggregate`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        pipeline: [
                            {
                                $match: {
                                    account: accountId,
                                    estado: 'activa',
                                    'config.general.opcionesEnvio.enPedido': true
                                }
                            },
                            { $limit: 1 }
                        ]
                    })
                });

                const result = await response.json();

                if (result.success && Array.isArray(result.data) && result.data.length > 0) {
                    this.config.plantillaContratos = result.data[0];
                    console.log('✓ Plantilla de contratos cargada:', this.config.plantillaContratos.nombre);
                } else {
                    console.log('ℹ️ No hay plantilla de contratos activa configurada para envío en pedidos');
                    this.config.plantillaContratos = null;
                }
            } catch (error) {
                console.error('Error cargando plantilla de contratos:', error);
                this.config.plantillaContratos = null;
            }
        }

        requiereFirma() {
            if (!this.config.plantillaContratos) return false;
            if (!this.config.plantillaContratos.config) return false;
            if (!this.config.plantillaContratos.config.general) return false;
            return this.config.plantillaContratos.config.general.requiereFirma === true;
        }

        async loadProductImage(accountId, productKey, productType) {
            const API_URL = 'https://api.sacscloud.com/v1';

            try {
                const response = await fetch(`${API_URL}/articulos/getImagen`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        account: accountId,
                        key: productKey,
                        tipo: productType || 'Producto Simple'
                    })
                });

                if (!response.ok) {
                    throw new Error('Error al obtener imagen del producto');
                }

                const data = await response.json();

                if (data.success && data.data) {
                    return data.data;
                } else {
                    // Si no hay imagen, retornar null (usaremos placeholder)
                    return null;
                }
            } catch (error) {
                console.error('Error cargando imagen del producto:', error);
                return null;
            }
        }

        getProductInitial(productName) {
            if (!productName || typeof productName !== 'string') return '?';
            return productName.trim().charAt(0).toUpperCase();
        }

        renderButton() {
            const container = document.getElementById(this.containerId);
            if (!container) {
                console.warn(`⚠️ Contenedor no encontrado: ${this.containerId}`);
                return;
            }

            const button = document.createElement('button');
            const styles = this.config.checkoutButtonStyles;
            button.textContent = styles.text || 'Comprar Ahora';

            const padding = styles.size === 'small' ? '8px 16px'
                          : styles.size === 'large' ? '16px 32px'
                          : '12px 24px';

            const fontSize = styles.size === 'small' ? '13px'
                           : styles.size === 'large' ? '18px'
                           : '15px';

            button.style.cssText = `
                background: ${styles.bgColor || '#000000'};
                color: ${styles.textColor || '#FFFFFF'};
                padding: ${padding};
                font-size: ${fontSize};
                border: none;
                border-radius: 8px;
                cursor: pointer;
                font-weight: 600;
                font-family: inherit;
                transition: opacity 0.2s;
            `;

            button.onmouseover = () => button.style.opacity = '0.9';
            button.onmouseout = () => button.style.opacity = '1';
            button.onclick = () => this.open();

            container.appendChild(button);
        }

        async loadStripe() {
            // Esperar si todavía no tenemos el stripeAccountId
            let attempts = 0;
            while (!this.config.stripeAccountId && attempts < 50) {
                await new Promise(resolve => setTimeout(resolve, 100));
                attempts++;
            }

            if (!this.config.stripeAccountId) {
                console.error('No se pudo obtener el Stripe Account ID');
                return;
            }

            // Cargar Stripe.js si no está cargado
            if (!window.Stripe) {
                const script = document.createElement('script');
                script.src = 'https://js.stripe.com/v3/';
                await new Promise((resolve, reject) => {
                    script.onload = resolve;
                    script.onerror = reject;
                    document.head.appendChild(script);
                });
            }

            // Determinar la llave a usar basándose en la configuración de la cuenta
            const stripePublishableKey = this.config.stripeTestMode
                ? STRIPE_KEYS.test
                : STRIPE_KEYS.live;

            console.log(`[SACS Checkout] Stripe Mode: ${this.config.stripeTestMode ? 'TEST' : 'LIVE'}`);
            console.log(`[SACS Checkout] Using key: ${stripePublishableKey.substring(0, 20)}...`);

            // Inicializar Stripe con el stripeAccountId del tenant (Direct Charge)
            this.stripe = window.Stripe(stripePublishableKey, {
                stripeAccount: this.config.stripeAccountId
            });

            console.log('✓ Stripe inicializado con cuenta:', this.config.stripeAccountId);
        }

        injectStyles() {
            // Buscar o crear el elemento de estilos
            let style = document.getElementById('sacs-checkout-styles');

            if (!style) {
                style = document.createElement('style');
                style.id = 'sacs-checkout-styles';
                document.head.appendChild(style);
            }

            // Actualizar los estilos (se actualizan en cada instancia)
            style.textContent = `
                @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');

                .sacs-overlay {
                    position: fixed;
                    top: 0;
                    left: 0;
                    right: 0;
                    bottom: 0;
                    background: rgba(0, 0, 0, 0.5);
                    z-index: 999998;
                    opacity: 0;
                    transition: opacity 0.3s ease;
                }

                .sacs-overlay.active {
                    opacity: 1;
                }

                .sacs-drawer {
                    position: fixed;
                    top: 0;
                    right: 0;
                    bottom: 0;
                    width: 100%;
                    max-width: 640px;
                    background: ${this.config.drawerStyles.backgroundColor || '#1F2937'};
                    box-shadow: -4px 0 24px rgba(0, 0, 0, 0.15);
                    z-index: 999999;
                    transform: translateX(100%);
                    transition: transform 0.3s cubic-bezier(0.4, 0, 0.2, 1);
                    display: flex;
                    flex-direction: column;
                    font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                    color: ${this.config.drawerStyles.primaryTextColor || '#FFFFFF'};
                }

                .sacs-drawer.active {
                    transform: translateX(0);
                }

                .sacs-drawer-header {
                    padding: 32px 32px 24px;
                    border-bottom: 1px solid rgba(255, 255, 255, 0.1);
                    position: relative;
                }

                .sacs-close-btn {
                    position: absolute;
                    top: 24px;
                    right: 24px;
                    background: none;
                    border: none;
                    width: 32px;
                    height: 32px;
                    cursor: pointer;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    color: ${this.config.drawerStyles.secondaryTextColor || '#9CA3AF'};
                    transition: opacity 0.2s;
                }

                .sacs-close-btn:hover {
                    opacity: 1;
                }

                .sacs-drawer-title {
                    font-size: 32px;
                    font-weight: 700;
                    color: ${this.config.drawerStyles.primaryTextColor || '#FFFFFF'};
                    margin: 0 0 32px 0;
                }

                .sacs-stepper {
                    display: flex;
                    gap: 24px;
                    align-items: center;
                }

                .sacs-step {
                    display: flex;
                    align-items: center;
                    gap: 12px;
                    font-size: 16px;
                    color: ${this.config.drawerStyles.secondaryTextColor || '#9CA3AF'};
                    transition: all 0.3s;
                }

                .sacs-step.active {
                    color: ${this.config.drawerStyles.primaryTextColor || '#FFFFFF'};
                    opacity: 1;
                }

                .sacs-step.completed {
                    color: ${this.config.drawerStyles.primaryTextColor || '#FFFFFF'};
                    opacity: 1;
                }

                .sacs-step-number {
                    width: 40px;
                    height: 40px;
                    border-radius: 4px;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    font-weight: 600;
                    font-size: 18px;
                    background: #F3F4F6;
                    color: #9CA3AF;
                    transition: all 0.3s;
                }

                .sacs-step.active .sacs-step-number {
                    background: ${this.config.drawerStyles.buttonBgColor || '#000000'};
                    color: ${this.config.drawerStyles.buttonTextColor || '#FFFFFF'};
                }

                .sacs-step.completed .sacs-step-number {
                    background: ${this.config.drawerStyles.buttonBgColor || '#000000'};
                    color: ${this.config.drawerStyles.buttonTextColor || '#FFFFFF'};
                }

                .sacs-step-check {
                    width: 20px;
                    height: 20px;
                    stroke: white;
                    stroke-width: 3;
                }

                .sacs-drawer-body {
                    flex: 1;
                    overflow-y: auto;
                    padding: 32px;
                }

                .sacs-cart-item {
                    display: flex;
                    gap: 20px;
                    padding: 24px;
                    margin-bottom: 16px;
                    background: rgba(255, 255, 255, 0.05);
                    border: 1px solid rgba(255, 255, 255, 0.1);
                    border-radius: 8px;
                }

                .sacs-cart-item:first-child {
                    padding: 24px;
                }

                .sacs-item-image {
                    width: 80px;
                    height: 80px;
                    object-fit: cover;
                    border-radius: 8px;
                    background: #F3F4F6;
                    flex-shrink: 0;
                }

                .sacs-item-placeholder {
                    width: 80px;
                    height: 80px;
                    border-radius: 8px;
                    background: linear-gradient(135deg, #DBEAFE 0%, #BFDBFE 100%);
                    border: 1px solid #93C5FD;
                    flex-shrink: 0;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    font-weight: 700;
                    font-size: 32px;
                    color: #1E40AF;
                    text-transform: uppercase;
                    font-family: -apple-system, BlinkMacSystemFont, 'Inter', 'Segoe UI', sans-serif;
                }

                .sacs-item-info {
                    flex: 1;
                    display: flex;
                    flex-direction: column;
                    gap: 8px;
                }

                .sacs-item-name {
                    font-weight: 600;
                    font-size: 18px;
                    color: ${this.config.drawerStyles.primaryTextColor || '#FFFFFF'};
                    margin: 0;
                }

                .sacs-item-variant {
                    font-size: 14px;
                    color: ${this.config.drawerStyles.secondaryTextColor || '#9CA3AF'};
                    margin: 0;
                }

                .sacs-item-footer {
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                    margin-top: auto;
                }

                .sacs-quantity-control {
                    display: flex;
                    align-items: center;
                    gap: 0;
                    border: 1px solid rgba(255, 255, 255, 0.2);
                    border-radius: 4px;
                    overflow: hidden;
                    background: rgba(255, 255, 255, 0.05);
                }

                .sacs-qty-btn {
                    width: 40px;
                    height: 40px;
                    border: none;
                    background: transparent;
                    cursor: pointer;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    font-size: 18px;
                    color: ${this.config.drawerStyles.primaryTextColor || '#FFFFFF'};
                    transition: background 0.2s;
                    border-right: 1px solid rgba(255, 255, 255, 0.2);
                }

                .sacs-qty-btn:last-child {
                    border-right: none;
                    border-left: 1px solid rgba(255, 255, 255, 0.2);
                }

                .sacs-qty-btn:hover {
                    background: rgba(255, 255, 255, 0.1);
                }

                .sacs-qty-btn:disabled {
                    opacity: 0.3;
                    cursor: not-allowed;
                }

                .sacs-qty-display {
                    width: 40px;
                    text-align: center;
                    font-weight: 500;
                    color: ${this.config.drawerStyles.primaryTextColor || '#FFFFFF'};
                }

                .sacs-item-price {
                    font-weight: 600;
                    font-size: 18px;
                    color: ${this.config.drawerStyles.primaryTextColor || '#FFFFFF'};
                }

                .sacs-drawer-footer {
                    padding: 24px 32px;
                    border-top: 1px solid rgba(255, 255, 255, 0.1);
                    background: ${this.config.drawerStyles.backgroundColor || '#1F2937'};
                }

                .sacs-summary {
                    margin-bottom: 24px;
                }

                .sacs-summary-row {
                    display: flex;
                    justify-content: space-between;
                    margin-bottom: 12px;
                    font-size: 16px;
                    color: ${this.config.drawerStyles.secondaryTextColor || '#9CA3AF'};
                }

                .sacs-summary-row.total {
                    margin-top: 12px;
                    padding-top: 12px;
                    border-top: 1px solid rgba(255, 255, 255, 0.1);
                    font-size: 20px;
                    font-weight: 700;
                    color: ${this.config.drawerStyles.primaryTextColor || '#FFFFFF'};
                }

                .sacs-btn {
                    width: 100%;
                    padding: 16px;
                    border: none;
                    border-radius: 4px;
                    font-size: 16px;
                    font-weight: 600;
                    cursor: pointer;
                    transition: all 0.2s;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    gap: 8px;
                    font-family: inherit;
                }

                .sacs-btn-primary {
                    background: ${this.config.drawerStyles.buttonBgColor || '#000000'};
                    color: ${this.config.drawerStyles.buttonTextColor || '#FFFFFF'};
                }

                .sacs-btn-primary:hover {
                    background: ${this.config.drawerStyles.buttonHoverColor || '#374151'};
                }

                .sacs-btn-primary:disabled {
                    background: #9CA3AF;
                    cursor: not-allowed;
                }

                .sacs-section-title {
                    font-size: 14px;
                    font-weight: 600;
                    color: ${this.config.drawerStyles.secondaryTextColor || '#9CA3AF'};
                    text-transform: uppercase;
                    letter-spacing: 0.05em;
                    margin: 0 0 16px 0;
                }

                .sacs-form-group {
                    margin-bottom: 20px;
                }

                .sacs-form-label {
                    display: block;
                    font-size: 15px;
                    font-weight: 500;
                    color: ${this.config.drawerStyles.primaryTextColor || '#FFFFFF'};
                    margin-bottom: 8px;
                }

                .sacs-form-input {
                    width: 100%;
                    padding: 12px 16px;
                    border: 1px solid ${this.config.drawerStyles.secondaryTextColor || '#6B7280'};
                    border-radius: 4px;
                    font-size: 15px;
                    font-family: inherit;
                    transition: all 0.2s;
                    background: transparent;
                    box-sizing: border-box;
                    color: ${this.config.drawerStyles.primaryTextColor || '#000000'};
                }

                .sacs-form-input::placeholder {
                    color: ${this.config.drawerStyles.secondaryTextColor || '#6B7280'};
                    opacity: 0.6;
                }

                .sacs-form-input:focus {
                    outline: none;
                    border-color: ${this.config.drawerStyles.buttonBgColor || '#000000'};
                }

                .sacs-form-row {
                    display: grid;
                    grid-template-columns: 1fr 1fr;
                    gap: 16px;
                }

                .sacs-back-btn {
                    display: flex;
                    align-items: center;
                    gap: 8px;
                    background: none;
                    border: none;
                    font-size: 16px;
                    color: ${this.config.drawerStyles.secondaryTextColor || '#9CA3AF'};
                    cursor: pointer;
                    padding: 0;
                    margin-bottom: 32px;
                    font-family: inherit;
                    font-weight: 500;
                }

                .sacs-back-btn:hover {
                    opacity: 1;
                }

                .sacs-page-title {
                    font-size: 32px;
                    font-weight: 700;
                    color: ${this.config.drawerStyles.primaryTextColor || '#FFFFFF'};
                    margin: 0 0 32px 0;
                }

                .sacs-success-container {
                    text-align: center;
                    padding: 48px 0;
                }

                .sacs-success-icon {
                    width: 80px;
                    height: 80px;
                    margin: 0 auto 32px;
                    background: ${this.config.drawerStyles.buttonBgColor || '#000000'};
                    border-radius: 8px;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                }

                .sacs-success-check {
                    width: 48px;
                    height: 48px;
                    stroke: ${this.config.drawerStyles.buttonTextColor || '#FFFFFF'};
                    stroke-width: 3;
                }

                .sacs-success-title {
                    font-size: 28px;
                    font-weight: 700;
                    color: ${this.config.drawerStyles.primaryTextColor || '#FFFFFF'};
                    margin: 0 0 12px 0;
                }

                .sacs-success-subtitle {
                    font-size: 16px;
                    color: ${this.config.drawerStyles.secondaryTextColor || '#9CA3AF'};
                    margin: 0 0 32px 0;
                }

                .sacs-order-box {
                    background: rgba(255, 255, 255, 0.05);
                    border: 1px solid rgba(255, 255, 255, 0.1);
                    padding: 32px;
                    border-radius: 8px;
                    margin-bottom: 32px;
                }

                .sacs-order-label {
                    font-size: 12px;
                    font-weight: 600;
                    color: ${this.config.drawerStyles.secondaryTextColor || '#9CA3AF'};
                    text-transform: uppercase;
                    letter-spacing: 0.05em;
                    margin: 0 0 8px 0;
                }

                .sacs-order-number {
                    font-size: 24px;
                    font-weight: 700;
                    color: ${this.config.drawerStyles.primaryTextColor || '#FFFFFF'};
                    margin: 0 0 16px 0;
                }

                .sacs-order-total {
                    font-size: 16px;
                    color: ${this.config.drawerStyles.secondaryTextColor || '#9CA3AF'};
                    margin: 0;
                }

                .sacs-qr-container {
                    display: flex;
                    flex-direction: column;
                    align-items: center;
                    gap: 16px;
                }

                .sacs-qr-code {
                    width: 200px;
                    height: 200px;
                    background: white;
                    border-radius: 8px;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    padding: 8px;
                    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
                }

                .sacs-barcode {
                    width: 300px;
                    height: 60px;
                    background: transparent;
                    border-radius: 4px;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                }

                .sacs-info-box {
                    background: rgba(255, 255, 255, 0.05);
                    border: 1px solid rgba(255, 255, 255, 0.1);
                    padding: 20px;
                    border-radius: 8px;
                    margin-bottom: 16px;
                    display: flex;
                    gap: 16px;
                }

                .sacs-info-icon {
                    width: 24px;
                    height: 24px;
                    flex-shrink: 0;
                    color: ${this.config.drawerStyles.secondaryTextColor || '#9CA3AF'};
                }

                .sacs-info-content {
                    flex: 1;
                }

                .sacs-info-title {
                    font-size: 15px;
                    font-weight: 600;
                    color: ${this.config.drawerStyles.primaryTextColor || '#FFFFFF'};
                    margin: 0 0 4px 0;
                }

                .sacs-info-text {
                    font-size: 14px;
                    color: ${this.config.drawerStyles.secondaryTextColor || '#9CA3AF'};
                    margin: 0;
                }

                .sacs-payment-icons {
                    display: flex;
                    gap: 12px;
                    justify-content: center;
                    margin-top: 16px;
                    padding-top: 16px;
                    border-top: 1px solid #E5E7EB;
                }

                .sacs-payment-icon {
                    width: 50px;
                    height: 32px;
                    object-fit: contain;
                    opacity: 0.6;
                }

                .sacs-secure-text {
                    text-align: center;
                    font-size: 13px;
                    color: ${this.config.drawerStyles.secondaryTextColor || '#9CA3AF'};
                    margin-top: 12px;
                }

                .sacs-spinner {
                    border: 2px solid rgba(255, 255, 255, 0.3);
                    border-top: 2px solid white;
                    border-radius: 50%;
                    width: 16px;
                    height: 16px;
                    animation: sacs-spin 1s linear infinite;
                }

                @keyframes sacs-spin {
                    0% { transform: rotate(0deg); }
                    100% { transform: rotate(360deg); }
                }

                .sacs-error-message {
                    background: #FEE2E2;
                    color: #DC2626;
                    padding: 12px 16px;
                    border-radius: 4px;
                    margin-bottom: 16px;
                    font-size: 14px;
                }

                .sacs-stripe-element {
                    padding: 12px 16px;
                    border: 1px solid ${this.config.drawerStyles.secondaryTextColor || '#6B7280'};
                    border-radius: 4px;
                    background: transparent;
                }

                @media (max-width: 640px) {
                    .sacs-drawer {
                        max-width: 100%;
                    }

                    .sacs-drawer-title {
                        font-size: 24px;
                    }

                    .sacs-page-title {
                        font-size: 24px;
                    }

                    .sacs-form-row {
                        grid-template-columns: 1fr;
                    }

                    .sacs-stepper {
                        gap: 12px;
                    }

                    .sacs-step-label {
                        display: none;
                    }

                    .sacs-doc-info {
                        font-size: 14px;
                    }

                    .sacs-firma-instructions {
                        font-size: 13px;
                        padding: 0.75rem;
                    }

                    .sacs-canvas-container {
                        padding: 0.75rem;
                    }

                    #sacs-signature-canvas {
                        max-width: 100%;
                        height: 150px;
                    }

                    .sacs-firma-actions {
                        flex-direction: column;
                        gap: 0.5rem;
                    }

                    .sacs-firma-actions button {
                        width: 100%;
                    }
                }

                /* ==================== ESTILOS PARA FIRMA DIGITAL ==================== */

                .sacs-doc-info {
                    background: rgba(255, 255, 255, 0.05);
                    padding: 1rem;
                    border-radius: 8px;
                    margin-bottom: 1rem;
                    border: 1px solid rgba(255, 255, 255, 0.1);
                }

                .sacs-doc-info p {
                    margin: 0.5rem 0;
                    color: ${this.config.drawerStyles.primaryTextColor || '#FFFFFF'};
                    font-size: 15px;
                    line-height: 1.6;
                }

                .sacs-doc-info strong {
                    color: ${this.config.drawerStyles.secondaryTextColor || '#9CA3AF'};
                    font-weight: 600;
                }

                .sacs-firma-instructions {
                    background: rgba(59, 130, 246, 0.1);
                    border-left: 4px solid #3B82F6;
                    padding: 1rem;
                    margin-bottom: 1.5rem;
                    border-radius: 4px;
                    color: ${this.config.drawerStyles.primaryTextColor || '#FFFFFF'};
                }

                .sacs-firma-instructions p {
                    margin: 0;
                    font-size: 14px;
                    line-height: 1.5;
                }

                .sacs-canvas-container {
                    position: relative;
                    border: 2px dashed rgba(255, 255, 255, 0.2);
                    border-radius: 8px;
                    background: rgba(255, 255, 255, 0.03);
                    padding: 1rem;
                    margin-bottom: 1.5rem;
                }

                #sacs-signature-canvas {
                    border: 1px solid rgba(255, 255, 255, 0.1);
                    border-radius: 4px;
                    cursor: crosshair;
                    touch-action: none;
                    background: #FFFFFF;
                    width: 100%;
                    max-width: 540px;
                    height: 200px;
                    display: block;
                }

                .sacs-canvas-placeholder {
                    position: absolute;
                    top: 50%;
                    left: 50%;
                    transform: translate(-50%, -50%);
                    color: #9CA3AF;
                    pointer-events: none;
                    font-size: 0.875rem;
                    text-align: center;
                }

                .sacs-canvas-placeholder.hidden {
                    display: none;
                }

                .sacs-firma-actions {
                    display: flex;
                    gap: 0.75rem;
                    justify-content: flex-end;
                }

                .sacs-btn-secondary {
                    padding: 0.75rem 1.5rem;
                    background: rgba(255, 255, 255, 0.1);
                    color: ${this.config.drawerStyles.primaryTextColor || '#FFFFFF'};
                    border: 1px solid rgba(255, 255, 255, 0.2);
                    border-radius: 6px;
                    font-weight: 600;
                    cursor: pointer;
                    display: inline-flex;
                    align-items: center;
                    gap: 0.5rem;
                    font-size: 15px;
                    transition: all 0.2s;
                }

                .sacs-btn-secondary:hover {
                    background: rgba(255, 255, 255, 0.15);
                }

                .sacs-btn-primary {
                    padding: 0.75rem 1.5rem;
                    background: ${this.config.drawerStyles.buttonBgColor || '#000000'};
                    color: ${this.config.drawerStyles.buttonTextColor || '#FFFFFF'};
                    border: none;
                    border-radius: 6px;
                    font-weight: 600;
                    cursor: pointer;
                    display: inline-flex;
                    align-items: center;
                    gap: 0.5rem;
                    font-size: 15px;
                    transition: all 0.2s;
                }

                .sacs-btn-primary:hover:not(:disabled) {
                    opacity: 0.9;
                }

                .sacs-btn-primary:disabled {
                    opacity: 0.5;
                    cursor: not-allowed;
                }

                /* ==================== ESTILOS PARA TÉRMINOS Y PREVIEW ==================== */

                .sacs-terms-container {
                    margin: 20px 0;
                    padding: 16px;
                    background: #f8fafc;
                    border-radius: 12px;
                    border: 1px solid #e2e8f0;
                }

                .sacs-terms-checkbox {
                    display: flex;
                    align-items: flex-start;
                    gap: 12px;
                    cursor: pointer;
                }

                .sacs-terms-checkbox input[type="checkbox"] {
                    width: 20px;
                    height: 20px;
                    margin-top: 2px;
                    cursor: pointer;
                    accent-color: #6366f1;
                }

                .sacs-terms-checkbox label {
                    font-size: 14px;
                    color: #374151;
                    line-height: 1.5;
                    cursor: pointer;
                }

                .sacs-preview-link {
                    display: inline-flex;
                    align-items: center;
                    gap: 6px;
                    margin-top: 12px;
                    padding: 8px 16px;
                    background: transparent;
                    border: 1px solid #6366f1;
                    border-radius: 8px;
                    color: #6366f1;
                    font-size: 14px;
                    font-weight: 500;
                    cursor: pointer;
                    transition: all 0.2s;
                }

                .sacs-preview-link:hover {
                    background: #6366f1;
                    color: white;
                }

                .sacs-preview-link svg {
                    width: 18px;
                    height: 18px;
                }

                /* Modal de Preview del Documento */
                .sacs-preview-overlay {
                    display: none;
                    position: fixed;
                    top: 0;
                    left: 0;
                    width: 100%;
                    height: 100%;
                    background: rgba(0, 0, 0, 0.7);
                    z-index: 10001;
                    justify-content: center;
                    align-items: center;
                    padding: 20px;
                    box-sizing: border-box;
                }

                .sacs-preview-overlay.active {
                    display: flex;
                }

                .sacs-preview-modal {
                    background: white;
                    border-radius: 16px;
                    width: 100%;
                    max-width: 800px;
                    max-height: 90vh;
                    display: flex;
                    flex-direction: column;
                    overflow: hidden;
                    box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.25);
                }

                .sacs-preview-header {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    padding: 20px 24px;
                    border-bottom: 1px solid #e5e7eb;
                    background: #f9fafb;
                }

                .sacs-preview-header h2 {
                    margin: 0;
                    font-size: 18px;
                    font-weight: 600;
                    color: #1f2937;
                }

                .sacs-preview-close-btn {
                    background: none;
                    border: none;
                    padding: 8px;
                    cursor: pointer;
                    border-radius: 8px;
                    transition: background 0.2s;
                }

                .sacs-preview-close-btn:hover {
                    background: #e5e7eb;
                }

                .sacs-preview-close-btn svg {
                    width: 24px;
                    height: 24px;
                    stroke: #6b7280;
                }

                .sacs-preview-document {
                    flex: 1;
                    overflow-y: auto;
                    padding: 32px;
                    font-family: 'Georgia', serif;
                    line-height: 1.8;
                    color: #1f2937;
                }

                .sacs-preview-document .doc-header {
                    text-align: center;
                    margin-bottom: 32px;
                    padding-bottom: 24px;
                    border-bottom: 2px solid #e5e7eb;
                }

                .sacs-preview-document .doc-logo img {
                    max-height: 80px;
                    margin-bottom: 16px;
                }

                .sacs-preview-document .doc-company-name {
                    font-size: 24px;
                    font-weight: 700;
                    margin: 0 0 8px 0;
                    color: #111827;
                }

                .sacs-preview-document .doc-empresa-info {
                    font-size: 13px;
                    color: #6b7280;
                }

                .sacs-preview-document .doc-empresa-info p {
                    margin: 4px 0;
                }

                .sacs-preview-document .doc-title {
                    text-align: center;
                    font-size: 22px;
                    font-weight: 700;
                    margin: 0 0 8px 0;
                    color: #111827;
                }

                .sacs-preview-document .doc-subtitle {
                    text-align: center;
                    font-size: 14px;
                    color: #6b7280;
                    margin: 0 0 32px 0;
                }

                .sacs-preview-document .doc-section {
                    margin-bottom: 24px;
                }

                .sacs-preview-document .doc-section-title {
                    font-size: 16px;
                    font-weight: 600;
                    color: #374151;
                    margin: 0 0 12px 0;
                    padding-bottom: 8px;
                    border-bottom: 1px solid #e5e7eb;
                }

                .sacs-preview-document .doc-content {
                    font-size: 14px;
                    text-align: justify;
                    white-space: pre-wrap;
                }

                .sacs-preview-document .doc-client-info {
                    background: #f9fafb;
                    padding: 16px;
                    border-radius: 8px;
                    margin-bottom: 24px;
                }

                .sacs-preview-document .doc-client-info p {
                    margin: 6px 0;
                    font-size: 14px;
                }

                .sacs-preview-document .doc-text {
                    font-size: 14px;
                    line-height: 1.8;
                    color: #374151;
                    margin: 16px 0;
                    text-align: justify;
                }

                .sacs-preview-document .doc-clausula {
                    margin-bottom: 24px;
                }

                .sacs-preview-document .doc-clausula-header {
                    display: flex;
                    align-items: center;
                    gap: 12px;
                    margin-bottom: 8px;
                }

                .sacs-preview-document .doc-clausula-numero {
                    font-size: 13px;
                    font-weight: 600;
                    color: #1f2937;
                }

                .sacs-preview-document .doc-clausula-categoria {
                    font-size: 10px;
                    letter-spacing: 1px;
                    text-transform: uppercase;
                    background: #f3f4f6;
                    color: #6b7280;
                    padding: 4px 10px;
                    border-radius: 4px;
                    font-weight: 500;
                }

                .sacs-preview-document .doc-clausula-texto {
                    font-size: 14px;
                    color: #4b5563;
                    line-height: 1.7;
                    margin: 0;
                    padding-left: 24px;
                }

                .sacs-preview-document .doc-fields {
                    display: grid;
                    grid-template-columns: repeat(2, 1fr);
                    gap: 16px;
                }

                .sacs-preview-document .doc-field {
                    padding: 12px 0;
                    border-bottom: 1px solid #e5e7eb;
                }

                .sacs-preview-document .doc-field-label {
                    font-size: 10px;
                    letter-spacing: 1px;
                    text-transform: uppercase;
                    color: #9ca3af;
                    margin: 0 0 6px 0;
                    font-weight: 500;
                }

                .sacs-preview-document .doc-field-value {
                    font-size: 15px;
                    color: #1f2937;
                    margin: 0;
                }

                .sacs-preview-document .signature-section {
                    margin-top: 32px;
                    text-align: center;
                }

                .sacs-preview-document .signature-box {
                    border: 1px solid #e5e7eb;
                    padding: 24px;
                    margin: 16px auto;
                    max-width: 280px;
                    border-radius: 8px;
                }

                .sacs-preview-document .signature-placeholder {
                    color: #d1d5db;
                    font-size: 12px;
                    letter-spacing: 1px;
                    text-transform: uppercase;
                }

                .sacs-preview-document .doc-footer {
                    margin-top: 32px;
                    padding-top: 16px;
                    border-top: 1px solid #e5e7eb;
                }

                .sacs-preview-document .legal-text {
                    font-size: 12px;
                    color: #9ca3af;
                    text-align: center;
                    margin: 0;
                    line-height: 1.6;
                }

                .sacs-preview-footer {
                    padding: 16px 24px;
                    border-top: 1px solid #e5e7eb;
                    background: #f9fafb;
                    text-align: center;
                }

                .sacs-preview-footer button {
                    padding: 12px 32px;
                    background: #6366f1;
                    color: white;
                    border: none;
                    border-radius: 8px;
                    font-size: 15px;
                    font-weight: 600;
                    cursor: pointer;
                    transition: opacity 0.2s;
                }

                .sacs-preview-footer button:hover {
                    opacity: 0.9;
                }

                /* ==================== FIN ESTILOS PARA TÉRMINOS Y PREVIEW ==================== */

                /* ==================== FIN ESTILOS PARA FIRMA DIGITAL ==================== */
            `;
        }

        open() {
            if (this.isOpen) return;

            this.isOpen = true;
            this.currentStep = 1;
            this.render();

            // Abrir con animación
            requestAnimationFrame(() => {
                const overlay = document.getElementById('sacs-overlay');
                const drawer = document.getElementById('sacs-drawer');
                if (overlay) overlay.classList.add('active');
                if (drawer) drawer.classList.add('active');
            });
        }

        close() {
            console.log('CLOSE llamado - stack trace:');
            console.trace();

            const overlay = document.getElementById('sacs-overlay');
            const drawer = document.getElementById('sacs-drawer');

            if (overlay) overlay.classList.remove('active');
            if (drawer) drawer.classList.remove('active');

            setTimeout(() => {
                this.isOpen = false;
                if (overlay) overlay.remove();
                if (drawer) drawer.remove();
            }, 300);
        }

        render() {
            // Si ya existe el drawer, solo actualizar contenido
            let existingDrawer = document.getElementById('sacs-drawer');
            let existingOverlay = document.getElementById('sacs-overlay');

            if (existingDrawer) {
                // Solo actualizar el contenido del drawer
                existingDrawer.innerHTML = this.getDrawerContent();
                this.attachEventListeners();
                return;
            }

            // Primera vez: crear overlay y drawer
            // Crear overlay
            const overlay = document.createElement('div');
            overlay.id = 'sacs-overlay';
            overlay.className = 'sacs-overlay';
            overlay.onclick = (e) => {
                // Solo cerrar si se hace clic directamente en el overlay, no en el drawer
                if (e.target === overlay) {
                    this.close();
                }
            };
            document.body.appendChild(overlay);

            // Crear drawer
            const drawer = document.createElement('div');
            drawer.id = 'sacs-drawer';
            drawer.className = 'sacs-drawer';
            drawer.innerHTML = this.getDrawerContent();
            document.body.appendChild(drawer);

            // Agregar event listeners
            this.attachEventListeners();
        }

        getDrawerContent() {
            return `
                <div class="sacs-drawer-header">
                    <button class="sacs-close-btn" onclick="sacsCheckout.close()">
                        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <line x1="18" y1="6" x2="6" y2="18"></line>
                            <line x1="6" y1="6" x2="18" y2="18"></line>
                        </svg>
                    </button>
                    <h1 class="sacs-drawer-title">${this.currentStep === 99 ? 'Atención Requerida' : 'Carrito de Compras'} <span style="font-size: 14px; opacity: 0.5; font-weight: 400;">v1.9.8</span></h1>
                    ${this.currentStep === 99 ? '' : this.renderStepper()}
                </div>
                ${this.renderBody()}
                ${this.renderFooter()}
            `;
        }

        renderStepper() {
            const requiereFirma = this.requiereFirma();
            // Nueva estructura: 1→2→3(firma condicional)→4(pago)→5(confirmar)
            // Sin firma: 1→2→4→5

            return `
                <div class="sacs-stepper">
                    <!-- Paso 1: Carrito -->
                    <div class="sacs-step ${this.currentStep >= 1 ? 'active' : ''} ${this.currentStep > 1 ? 'completed' : ''}">
                        <div class="sacs-step-number">
                            ${this.currentStep > 1 ? '<svg class="sacs-step-check" viewBox="0 0 24 24" fill="none"><polyline points="20 6 9 17 4 12"></polyline></svg>' : '1'}
                        </div>
                        <span class="sacs-step-label">Carrito</span>
                    </div>

                    <!-- Paso 2: Información -->
                    <div class="sacs-step ${this.currentStep >= 2 ? 'active' : ''} ${this.currentStep > 2 ? 'completed' : ''}">
                        <div class="sacs-step-number">
                            ${this.currentStep > 2 ? '<svg class="sacs-step-check" viewBox="0 0 24 24" fill="none"><polyline points="20 6 9 17 4 12"></polyline></svg>' : '2'}
                        </div>
                        <span class="sacs-step-label">Info</span>
                    </div>

                    <!-- Paso 3: Firma (condicional) -->
                    ${requiereFirma ? `
                        <div class="sacs-step ${this.currentStep >= 3 ? 'active' : ''} ${this.currentStep > 3 ? 'completed' : ''}">
                            <div class="sacs-step-number">
                                ${this.currentStep > 3 ? '<svg class="sacs-step-check" viewBox="0 0 24 24" fill="none"><polyline points="20 6 9 17 4 12"></polyline></svg>' : '3'}
                            </div>
                            <span class="sacs-step-label">Firma</span>
                        </div>
                    ` : ''}

                    <!-- Paso 4: Pago (SIEMPRE, FIJO) -->
                    <div class="sacs-step ${this.currentStep >= 4 ? 'active' : ''} ${this.currentStep > 4 ? 'completed' : ''}">
                        <div class="sacs-step-number">
                            ${this.currentStep > 4 ? '<svg class="sacs-step-check" viewBox="0 0 24 24" fill="none"><polyline points="20 6 9 17 4 12"></polyline></svg>' : (requiereFirma ? '4' : '3')}
                        </div>
                        <span class="sacs-step-label">Pago</span>
                    </div>

                    <!-- Paso 5: Confirmar -->
                    <div class="sacs-step ${this.currentStep >= 5 ? 'active' : ''}">
                        <div class="sacs-step-number">${requiereFirma ? '5' : '4'}</div>
                        <span class="sacs-step-label">Confirmar</span>
                    </div>
                </div>
            `;
        }

        renderBody() {
            const requiereFirma = this.requiereFirma();

            switch (this.currentStep) {
                case 1:
                    return this.renderCart();
                case 2:
                    return this.renderInfoCliente();
                case 3:
                    // Paso 3 solo existe si requiere firma
                    return this.renderFirma();
                case 4:
                    // Paso 4 es SIEMPRE pago
                    return this.renderPago();
                case 5:
                    // Paso 5 es confirmación
                    return this.renderSuccess();
                case 99:
                    // Caso especial: Error en creación de pedido pero pago exitoso
                    return this.renderPaymentError();
                default:
                    return this.renderCart();
            }
        }

        renderCart() {
            return `
                <div class="sacs-drawer-body">
                    ${this.cart.map((item, index) => `
                        <div class="sacs-cart-item">
                            ${item.imageUrl
                                ? `<img class="sacs-item-image" src="${item.imageUrl}" alt="${item.nombre}">`
                                : `<div class="sacs-item-placeholder">
                                    ${this.getProductInitial(item.nombre)}
                                   </div>`
                            }
                            <div class="sacs-item-info">
                                <h3 class="sacs-item-name">${item.nombre}</h3>
                                ${item.variant ? `<p class="sacs-item-variant">${item.variant}</p>` : ''}
                                <div class="sacs-item-footer">
                                    <div class="sacs-quantity-control">
                                        <button class="sacs-qty-btn" onclick="sacsCheckout.updateQuantity(${index}, ${item.quantity - 1})">−</button>
                                        <span class="sacs-qty-display">${item.quantity}</span>
                                        <button class="sacs-qty-btn" onclick="sacsCheckout.updateQuantity(${index}, ${item.quantity + 1})">+</button>
                                    </div>
                                    <span class="sacs-item-price">$${(parseFloat(item.precio) * item.quantity).toFixed(2)}</span>
                                </div>
                            </div>
                        </div>
                    `).join('')}
                </div>
            `;
        }

        renderInfoCliente() {
            return `
                <div class="sacs-drawer-body">
                    <button class="sacs-back-btn" onclick="sacsCheckout.goToStep(1)">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <polyline points="15 18 9 12 15 6"></polyline>
                        </svg>
                        Atrás
                    </button>
                    <h2 class="sacs-page-title">Información general</h2>

                    <div id="sacs-error-container"></div>

                    <div style="margin-bottom: 32px;">
                        <h3 class="sacs-section-title">CONTACTO</h3>
                        <div class="sacs-form-group">
                            <label class="sacs-form-label">Correo Electrónico</label>
                            <input type="email" class="sacs-form-input" id="sacs-correo" value="${this.customerInfo.correo}" placeholder="tu@correo.com" required>
                        </div>
                    </div>

                    <div style="margin-bottom: 32px;">
                        <h3 class="sacs-section-title">Información general</h3>
                        <div class="sacs-form-group">
                            <label class="sacs-form-label">Nombre Completo</label>
                            <input type="text" class="sacs-form-input" id="sacs-nombre" value="${this.customerInfo.nombre}" placeholder="Juan Pérez" required>
                        </div>
                        <div class="sacs-form-group">
                            <label class="sacs-form-label">Dirección</label>
                            <input type="text" class="sacs-form-input" id="sacs-direccion" value="${this.customerInfo.direccion}" placeholder="Calle Principal 123" required>
                        </div>
                        <div class="sacs-form-row">
                            <div class="sacs-form-group">
                                <label class="sacs-form-label">Ciudad</label>
                                <input type="text" class="sacs-form-input" id="sacs-ciudad" value="${this.customerInfo.ciudad}" placeholder="Ciudad de México" required>
                            </div>
                            <div class="sacs-form-group">
                                <label class="sacs-form-label">Código Postal</label>
                                <input type="text" class="sacs-form-input" id="sacs-cp" value="${this.customerInfo.codigoPostal}" placeholder="01000" required>
                            </div>
                        </div>
                    </div>
                </div>
            `;
        }

        renderPago() {
            return `
                <div class="sacs-drawer-body">
                    <button class="sacs-back-btn" onclick="sacsCheckout.volverDesdePago()">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <polyline points="15 18 9 12 15 6"></polyline>
                        </svg>
                        Atrás
                    </button>
                    <h2 class="sacs-page-title">Pago</h2>

                    <div id="sacs-error-container"></div>

                    <div>
                        <h3 class="sacs-section-title">INFORMACIÓN DE PAGO</h3>
                        <div class="sacs-form-group">
                            <label class="sacs-form-label">Número de Tarjeta</label>
                            <div id="card-element" class="sacs-stripe-element"></div>
                        </div>
                    </div>
                </div>
            `;
        }

        renderFirma() {
            const plantilla = this.config.plantillaContratos;
            const titulo = plantilla?.contenidoInfo?.titulo || 'Documento de Firma';

            return `
                <div class="sacs-drawer-body">
                    <button class="sacs-back-btn" onclick="sacsCheckout.goToStep(2)">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <polyline points="15 18 9 12 15 6"></polyline>
                        </svg>
                        Atrás
                    </button>

                    <h2 class="sacs-page-title">Firma del Documento</h2>

                    <div class="sacs-doc-info">
                        <p><strong>Documento:</strong> ${titulo}</p>
                        <p><strong>Cliente:</strong> ${this.customerInfo.nombre}</p>
                        <p><strong>Fecha:</strong> ${new Date().toLocaleDateString('es-MX', {
                            year: 'numeric',
                            month: 'long',
                            day: 'numeric'
                        })}</p>
                    </div>

                    <!-- Términos y condiciones -->
                    <div class="sacs-terms-container">
                        <div class="sacs-terms-checkbox">
                            <input type="checkbox" id="sacs-terms-checkbox-${this.instanceId}" onchange="sacsCheckout.onTermsChange('${this.instanceId}')">
                            <label for="sacs-terms-checkbox-${this.instanceId}">
                                He leído y acepto los términos y condiciones del presente documento.
                            </label>
                        </div>
                        <button class="sacs-preview-link" onclick="sacsCheckout.openDocumentPreview('${this.instanceId}')">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
                                <circle cx="12" cy="12" r="3"/>
                            </svg>
                            Ver documento completo
                        </button>
                    </div>

                    <div class="sacs-firma-instructions">
                        <p>✍️ Por favor, dibuje su firma en el recuadro de abajo usando el mouse o su dedo (en pantallas táctiles).</p>
                    </div>

                    <div class="sacs-canvas-container">
                        <canvas id="sacs-signature-canvas-${this.instanceId}" width="540" height="200"></canvas>
                        <div id="sacs-canvas-placeholder-${this.instanceId}" class="sacs-canvas-placeholder">
                            Dibuje su firma aquí
                        </div>
                    </div>

                    <div class="sacs-firma-actions">
                        <button id="sacs-limpiar-firma-btn-${this.instanceId}" class="sacs-btn sacs-btn-secondary">
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <polyline points="1 4 1 10 7 10"></polyline>
                                <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"></path>
                            </svg>
                            Limpiar
                        </button>
                        <button id="sacs-confirmar-firma-btn-${this.instanceId}" class="sacs-btn sacs-btn-primary" disabled>
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <polyline points="20 6 9 17 4 12"></polyline>
                            </svg>
                            Confirmar Firma
                        </button>
                    </div>
                </div>

                <!-- Modal de Preview del Documento -->
                <div class="sacs-preview-overlay" id="sacs-preview-overlay">
                    <div class="sacs-preview-modal">
                        <div class="sacs-preview-header">
                            <h2>Vista previa del documento</h2>
                            <button class="sacs-preview-close-btn" onclick="sacsCheckout.closeDocumentPreview()">
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                    <line x1="18" y1="6" x2="6" y2="18"/>
                                    <line x1="6" y1="6" x2="18" y2="18"/>
                                </svg>
                            </button>
                        </div>
                        <div class="sacs-preview-document" id="sacs-preview-document">
                            <!-- Se llenará dinámicamente -->
                        </div>
                        <div class="sacs-preview-footer">
                            <button onclick="sacsCheckout.closeDocumentPreview()">
                                Regresar a firmar
                            </button>
                        </div>
                    </div>
                </div>
            `;
        }

        renderSuccess() {
            const total = this.calculateTotal();
            const orderNumber = this.orderId || 'ORD' + Date.now();

            // Generar códigos después de renderizar
            setTimeout(() => this.generateCodes(orderNumber, total), 100);

            return `
                <div class="sacs-drawer-body">
                    <div class="sacs-success-container">
                        <div class="sacs-success-icon">
                            <svg class="sacs-success-check" viewBox="0 0 24 24" fill="none">
                                <polyline points="20 6 9 17 4 12"></polyline>
                            </svg>
                        </div>
                        <h2 class="sacs-success-title">¡Felicidades!</h2>
                        <p class="sacs-success-subtitle">Tu pedido ha sido confirmado</p>

                        <div class="sacs-order-box">
                            <p class="sacs-order-label">NÚMERO DE PEDIDO</p>
                            <h3 class="sacs-order-number">#${orderNumber}</h3>
                            <p class="sacs-order-total">Total: $${total.toFixed(2)}</p>
                        </div>

                        <div class="sacs-qr-container">
                            <div class="sacs-qr-code" id="sacs-qr-code"></div>
                            <div class="sacs-barcode" id="sacs-barcode"></div>
                        </div>

                        <div style="margin-top: 32px;">
                            <div class="sacs-info-box">
                                <svg class="sacs-info-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                    <rect x="2" y="7" width="20" height="15" rx="2" ry="2"></rect>
                                    <path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"></path>
                                </svg>
                                <div class="sacs-info-content">
                                    <h4 class="sacs-info-title">Toma una foto de esta pantalla</h4>
                                    <p class="sacs-info-text">Guarda esta confirmación para tus registros</p>
                                </div>
                            </div>
                            <div class="sacs-info-box">
                                <svg class="sacs-info-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                    <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"></path>
                                    <polyline points="22,6 12,13 2,6"></polyline>
                                </svg>
                                <div class="sacs-info-content">
                                    <h4 class="sacs-info-title">Revisa tu correo</h4>
                                    <p class="sacs-info-text">Te hemos enviado una confirmación con código QR y todos los detalles del pedido</p>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            `;
        }

        renderPaymentError() {
            const total = this.calculateTotal();
            const errorInfo = this.paymentError || {};
            const transactionId = errorInfo.paymentIntentId || 'No disponible';
            const errorMessage = errorInfo.message || 'Error desconocido';
            const errorDetails = errorInfo.details || '';

            return `
                <div class="sacs-drawer-body">
                    <div class="sacs-success-container">
                        <div class="sacs-success-icon" style="background: linear-gradient(135deg, #f59e0b 0%, #d97706 100%);">
                            <svg class="sacs-success-check" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="3">
                                <path d="M12 9v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path>
                            </svg>
                        </div>
                        <h2 class="sacs-success-title" style="color: #d97706;">Acción Requerida</h2>
                        <p class="sacs-success-subtitle">Tu pago fue procesado exitosamente, pero hubo un problema al crear el pedido</p>

                        <div class="sacs-order-box" style="border-color: #f59e0b; background: #fffbeb;">
                            <p class="sacs-order-label" style="color: #92400e;">ID DE TRANSACCIÓN</p>
                            <h3 class="sacs-order-number" style="color: #b45309; font-size: 16px; word-break: break-all;">${transactionId}</h3>
                            <p class="sacs-order-total" style="color: #92400e;">Total cobrado: $${total.toFixed(2)}</p>
                        </div>

                        <div style="margin-top: 24px; padding: 20px; background: #fef3c7; border-radius: 12px; border: 1px solid #fbbf24;">
                            <h4 style="margin: 0 0 12px 0; font-size: 16px; font-weight: 600; color: #92400e;">
                                <svg style="width: 20px; height: 20px; display: inline-block; vertical-align: middle; margin-right: 8px;" viewBox="0 0 24 24" fill="none" stroke="#92400e" stroke-width="2">
                                    <circle cx="12" cy="12" r="10"></circle>
                                    <line x1="12" y1="8" x2="12" y2="12"></line>
                                    <line x1="12" y1="16" x2="12.01" y2="16"></line>
                                </svg>
                                Razón del error:
                            </h4>
                            <p style="margin: 0; font-size: 14px; color: #78350f; line-height: 1.5;">
                                ${errorMessage}
                            </p>
                            ${errorDetails ? `<p style="margin: 8px 0 0 0; font-size: 12px; color: #92400e; opacity: 0.8; font-family: monospace; word-break: break-all;">${errorDetails}</p>` : ''}
                        </div>

                        <div style="margin-top: 24px;">
                            <div class="sacs-info-box" style="background: #f0fdf4; border-color: #86efac;">
                                <svg class="sacs-info-icon" style="color: #16a34a;" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                    <path d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"></path>
                                </svg>
                                <div class="sacs-info-content">
                                    <h4 class="sacs-info-title" style="color: #15803d;">Tu pago fue exitoso</h4>
                                    <p class="sacs-info-text" style="color: #166534;">El cargo de $${total.toFixed(2)} se procesó correctamente en tu tarjeta</p>
                                </div>
                            </div>
                            <div class="sacs-info-box" style="background: #fffbeb; border-color: #fbbf24;">
                                <svg class="sacs-info-icon" style="color: #d97706;" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                    <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"></path>
                                    <polyline points="22,6 12,13 2,6"></polyline>
                                </svg>
                                <div class="sacs-info-content">
                                    <h4 class="sacs-info-title" style="color: #92400e;">Toma una captura de pantalla</h4>
                                    <p class="sacs-info-text" style="color: #78350f;">Guarda el ID de transacción y contacta con nosotros para completar tu pedido manualmente</p>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            `;
        }

        async generateCodes(orderNumber, total) {
            // Cargar librerías desde CDN si no están cargadas
            await this.loadQRLibrary();
            await this.loadBarcodeLibrary();

            // Generar los códigos
            this.generateQRCode(orderNumber, total);
            this.generateBarcode(orderNumber);
        }

        async loadQRLibrary() {
            if (window.QRCode) return;

            return new Promise((resolve, reject) => {
                const script = document.createElement('script');
                script.src = 'https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js';
                script.onload = resolve;
                script.onerror = reject;
                document.head.appendChild(script);
            });
        }

        async loadBarcodeLibrary() {
            if (window.JsBarcode) return;

            return new Promise((resolve, reject) => {
                const script = document.createElement('script');
                script.src = 'https://cdn.jsdelivr.net/npm/jsbarcode@3.11.5/dist/JsBarcode.all.min.js';
                script.onload = resolve;
                script.onerror = reject;
                document.head.appendChild(script);
            });
        }

        generateQRCode(orderNumber, total) {
            const qrContainer = document.getElementById('sacs-qr-code');
            if (!qrContainer || !window.QRCode) return;

            // Limpiar contenedor
            qrContainer.innerHTML = '';

            // Datos del QR: número de orden y total
            const qrData = `Pedido: ${orderNumber}\nTotal: $${total.toFixed(2)}`;

            // Generar QR Code
            new QRCode(qrContainer, {
                text: qrData,
                width: 180,
                height: 180,
                colorDark: '#000000',
                colorLight: '#ffffff',
                correctLevel: QRCode.CorrectLevel.H
            });
        }

        generateBarcode(orderNumber) {
            const barcodeContainer = document.getElementById('sacs-barcode');
            if (!barcodeContainer || !window.JsBarcode) return;

            // Limpiar contenedor
            barcodeContainer.innerHTML = '';

            // Crear elemento SVG para el código de barras
            const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
            svg.setAttribute('id', 'sacs-barcode-svg');
            barcodeContainer.appendChild(svg);

            // Convertir número de orden a código numérico (solo números)
            const numericCode = orderNumber.replace(/[^0-9]/g, '').slice(0, 12);

            // Generar código de barras
            try {
                JsBarcode(svg, numericCode, {
                    format: 'CODE128',
                    width: 2,
                    height: 50,
                    displayValue: true,
                    fontSize: 12,
                    margin: 5
                });
            } catch (error) {
                console.error('Error generando código de barras:', error);
            }
        }

        renderFooter() {
            // Paso 2: Info del cliente - Solo botón sin resumen
            if (this.currentStep === 2) {
                return `
                    <div class="sacs-drawer-footer">
                        <button class="sacs-btn sacs-btn-primary" id="sacs-pay-btn">
                            <span id="sacs-btn-text">Continuar</span>
                        </button>
                    </div>
                `;
            }

            // Paso 3: Firma - Sin footer (botones dentro del body)
            if (this.currentStep === 3) {
                return '';
            }

            // Paso 5: Confirmación - Solo botón para cerrar
            if (this.currentStep === 5) {
                return `
                    <div class="sacs-drawer-footer">
                        <button class="sacs-btn sacs-btn-primary" onclick="sacsCheckout.close()">
                            Continuar Comprando
                        </button>
                    </div>
                `;
            }

            // Paso 99: Error de pedido (pago exitoso) - Solo botón para cerrar
            if (this.currentStep === 99) {
                return `
                    <div class="sacs-drawer-footer">
                        <button class="sacs-btn sacs-btn-primary" style="background: #d97706;" onclick="sacsCheckout.close()">
                            Cerrar
                        </button>
                    </div>
                `;
            }

            // Paso 1 (Carrito) y Paso 4 (Pago): Mostrar resumen de precios
            const total = this.calculateTotal();
            const subtotal = total / 1.16; // IVA 16%
            const taxes = total - subtotal;

            return `
                <div class="sacs-drawer-footer">
                    <div class="sacs-summary">
                        <div class="sacs-summary-row">
                            <span>Subtotal</span>
                            <span>$${subtotal.toFixed(2)}</span>
                        </div>
                        <div class="sacs-summary-row">
                            <span>Impuestos</span>
                            <span>$${taxes.toFixed(2)}</span>
                        </div>
                        <div class="sacs-summary-row total">
                            <span>Total</span>
                            <span>$${total.toFixed(2)}</span>
                        </div>
                    </div>
                    <button class="sacs-btn sacs-btn-primary" id="sacs-pay-btn">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <rect x="1" y="4" width="22" height="16" rx="2" ry="2"></rect>
                            <line x1="1" y1="10" x2="23" y2="10"></line>
                        </svg>
                        <span id="sacs-btn-text">${this.currentStep === 1 ? 'Continuar' : 'Completar Compra'}</span>
                        <span id="sacs-btn-spinner" style="display: none;" class="sacs-spinner"></span>
                    </button>
                    ${this.currentStep === 1 ? `
                        <div class="sacs-payment-icons">
                            <img class="sacs-payment-icon" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 48 32'%3E%3Crect fill='%231434CB' width='48' height='32' rx='4'/%3E%3Ctext x='24' y='20' font-family='Arial' font-size='12' font-weight='bold' fill='white' text-anchor='middle'%3EVISA%3C/text%3E%3C/svg%3E" alt="Visa">
                            <img class="sacs-payment-icon" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 48 32'%3E%3Crect fill='%23EB001B' width='48' height='32' rx='4'/%3E%3Ccircle cx='18' cy='16' r='8' fill='%23EB001B'/%3E%3Ccircle cx='30' cy='16' r='8' fill='%23F79E1B'/%3E%3C/svg%3E" alt="Mastercard">
                            <img class="sacs-payment-icon" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 48 32'%3E%3Crect fill='%23016FD0' width='48' height='32' rx='4'/%3E%3Ctext x='24' y='20' font-family='Arial' font-size='10' font-weight='bold' fill='white' text-anchor='middle'%3EAMEX%3C/text%3E%3C/svg%3E" alt="American Express">
                            <img class="sacs-payment-icon" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 48 32'%3E%3Crect fill='%23003087' width='48' height='32' rx='4'/%3E%3Ctext x='24' y='14' font-family='Arial' font-size='8' font-weight='bold' fill='%23009CDE' text-anchor='middle'%3EPayPal%3C/text%3E%3C/svg%3E" alt="PayPal">
                        </div>
                        <p class="sacs-secure-text">Pago seguro • ¡Consíguelo antes de que se agote!</p>
                    ` : ''}
                </div>
            `;
        }

        attachEventListeners() {
            // Event listener para el botón de pagar/completar compra
            const payBtn = document.getElementById('sacs-pay-btn');
            console.log('Attach listeners - payBtn:', payBtn, 'currentStep:', this.currentStep);

            if (payBtn) {
                payBtn.addEventListener('click', (e) => {
                    console.log('Click en botón - currentStep:', this.currentStep);
                    e.preventDefault();
                    e.stopPropagation();

                    if (this.currentStep === 1) {
                        // Paso 1: Ir a paso 2 (info cliente)
                        console.log('Ir a paso 2 (info cliente)');
                        this.goToStep(2);

                    } else if (this.currentStep === 2) {
                        // Paso 2: Capturar info y decidir siguiente paso
                        console.log('Capturando info del cliente...');

                        // Capturar info del formulario
                        this.customerInfo = {
                            correo: document.getElementById('sacs-correo').value.trim(),
                            nombre: document.getElementById('sacs-nombre').value.trim(),
                            direccion: document.getElementById('sacs-direccion').value.trim(),
                            ciudad: document.getElementById('sacs-ciudad').value.trim(),
                            codigoPostal: document.getElementById('sacs-cp').value.trim()
                        };

                        if (!this.validateCustomerInfo()) {
                            this.showError('Por favor completa todos los campos');
                            return;
                        }

                        // Decidir: ¿Requiere firma?
                        if (this.requiereFirma()) {
                            console.log('Ir a paso 3 (firma)');
                            this.goToStep(3);
                        } else {
                            console.log('Ir a paso 4 (pago)');
                            this.goToStep(4);
                        }

                    } else if (this.currentStep === 4) {
                        // Paso 4: Procesar pago
                        console.log('Procesar pago');
                        this.processPayment();
                    }
                });
            }

            // Inicializar canvas de firma si estamos en paso 3
            if (this.currentStep === 3) {
                setTimeout(() => this.initCanvasFirma(), 100);
            }

            // Inicializar Stripe si estamos en paso 4
            if (this.currentStep === 4) {
                setTimeout(() => this.initStripeElements(), 100);
            }
        }

        initStripeElements() {
            if (!this.stripe) {
                console.error('Stripe no está cargado');
                return;
            }

            const elements = this.stripe.elements();
            this.cardElement = elements.create('card', {
                style: {
                    base: {
                        fontSize: '15px',
                        color: '#111827',
                        fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif',
                        '::placeholder': {
                            color: '#9CA3AF'
                        }
                    }
                },
                hidePostalCode: true
            });

            this.cardElement.mount('#card-element');
        }

        updateQuantity(index, newQuantity) {
            if (newQuantity < 0) return;
            this.cart[index].quantity = newQuantity;
            this.render();
        }

        calculateTotal() {
            return this.cart.reduce((total, item) => {
                const precio = parseFloat(item.precio) || 0;
                const cantidad = parseInt(item.quantity) || 0;
                return total + (precio * cantidad);
            }, 0);
        }

        goToStep(step) {
            console.log('goToStep llamado - de', this.currentStep, 'a', step);
            this.currentStep = step;
            this.render();

            // Re-enfocar en el drawer después de cambiar de paso
            requestAnimationFrame(() => {
                const drawer = document.getElementById('sacs-drawer');
                if (drawer) {
                    drawer.scrollTop = 0; // Scroll al inicio
                }
            });
        }

        // ==================== MÉTODOS DEL CANVAS DE FIRMA ====================

        initCanvasFirma() {
            const canvas = document.getElementById(`sacs-signature-canvas-${this.instanceId}`);
            if (!canvas) {
                console.error('Canvas de firma no encontrado');
                return;
            }

            const ctx = canvas.getContext('2d');
            ctx.strokeStyle = '#000000';
            ctx.lineWidth = 2;
            ctx.lineCap = 'round';
            ctx.lineJoin = 'round';

            // Event listeners para mouse
            canvas.addEventListener('mousedown', (e) => this.startDrawing(e));
            canvas.addEventListener('mousemove', (e) => this.draw(e));
            canvas.addEventListener('mouseup', () => this.stopDrawing());
            canvas.addEventListener('mouseleave', () => this.stopDrawing());

            // Event listeners para touch (pantallas táctiles)
            canvas.addEventListener('touchstart', (e) => this.handleTouchStart(e), { passive: false });
            canvas.addEventListener('touchmove', (e) => this.handleTouchMove(e), { passive: false });
            canvas.addEventListener('touchend', () => this.stopDrawing());
            canvas.addEventListener('touchcancel', () => this.stopDrawing());

            // Event listeners para botones de firma
            const btnLimpiar = document.getElementById(`sacs-limpiar-firma-btn-${this.instanceId}`);
            const btnConfirmar = document.getElementById(`sacs-confirmar-firma-btn-${this.instanceId}`);

            if (btnLimpiar) {
                btnLimpiar.addEventListener('click', () => this.limpiarFirma());
            }

            if (btnConfirmar) {
                btnConfirmar.addEventListener('click', () => this.confirmarFirma());
            }

            // Event listeners para el modal de preview del documento
            const previewOverlay = document.getElementById('sacs-preview-overlay');
            if (previewOverlay) {
                // Cerrar al hacer clic fuera del modal
                previewOverlay.addEventListener('click', (e) => {
                    if (e.target === previewOverlay) {
                        this.closeDocumentPreview();
                    }
                });
            }

            // Cerrar modal con tecla ESC
            document.addEventListener('keydown', (e) => {
                if (e.key === 'Escape') {
                    this.closeDocumentPreview();
                }
            });

            console.log('✓ Canvas de firma inicializado para instancia:', this.instanceId);
        }

        getMousePos(canvas, evt) {
            const rect = canvas.getBoundingClientRect();
            return {
                x: evt.clientX - rect.left,
                y: evt.clientY - rect.top
            };
        }

        getTouchPos(canvas, touch) {
            const rect = canvas.getBoundingClientRect();
            return {
                x: touch.clientX - rect.left,
                y: touch.clientY - rect.top
            };
        }

        startDrawing(e) {
            this.isDrawing = true;
            const canvas = document.getElementById(`sacs-signature-canvas-${this.instanceId}`);
            const pos = this.getMousePos(canvas, e);
            this.lastX = pos.x;
            this.lastY = pos.y;
        }

        draw(e) {
            if (!this.isDrawing) return;

            const canvas = document.getElementById(`sacs-signature-canvas-${this.instanceId}`);
            const ctx = canvas.getContext('2d');
            const pos = this.getMousePos(canvas, e);

            ctx.beginPath();
            ctx.moveTo(this.lastX, this.lastY);
            ctx.lineTo(pos.x, pos.y);
            ctx.stroke();

            this.lastX = pos.x;
            this.lastY = pos.y;

            // Marcar que se ha dibujado algo
            if (!this.firmaDibujada) {
                console.log('✍️ Primera marca de firma detectada (mouse)');
                this.firmaDibujada = true;
                this.updateConfirmButtonState(); // Actualiza considerando firma + términos

                const placeholder = document.getElementById(`sacs-canvas-placeholder-${this.instanceId}`);
                if (placeholder) placeholder.style.display = 'none';
            }
        }

        stopDrawing() {
            this.isDrawing = false;
        }

        handleTouchStart(e) {
            e.preventDefault();
            const canvas = document.getElementById(`sacs-signature-canvas-${this.instanceId}`);
            const touch = e.touches[0];
            const pos = this.getTouchPos(canvas, touch);
            this.isDrawing = true;
            this.lastX = pos.x;
            this.lastY = pos.y;
        }

        handleTouchMove(e) {
            if (!this.isDrawing) return;
            e.preventDefault();

            const canvas = document.getElementById(`sacs-signature-canvas-${this.instanceId}`);
            const ctx = canvas.getContext('2d');
            const touch = e.touches[0];
            const pos = this.getTouchPos(canvas, touch);

            ctx.beginPath();
            ctx.moveTo(this.lastX, this.lastY);
            ctx.lineTo(pos.x, pos.y);
            ctx.stroke();

            this.lastX = pos.x;
            this.lastY = pos.y;

            // Marcar que se ha dibujado algo
            if (!this.firmaDibujada) {
                console.log('✍️ Primera marca de firma detectada (touch)');
                this.firmaDibujada = true;
                this.updateConfirmButtonState(); // Actualiza considerando firma + términos

                const placeholder = document.getElementById(`sacs-canvas-placeholder-${this.instanceId}`);
                if (placeholder) placeholder.style.display = 'none';
            }
        }

        limpiarFirma() {
            const canvas = document.getElementById(`sacs-signature-canvas-${this.instanceId}`);
            const ctx = canvas.getContext('2d');
            ctx.clearRect(0, 0, canvas.width, canvas.height);

            this.firmaDibujada = false;
            this.firmaBase64 = null;

            this.updateConfirmButtonState(); // Actualiza considerando firma + términos

            const placeholder = document.getElementById(`sacs-canvas-placeholder-${this.instanceId}`);
            if (placeholder) placeholder.style.display = 'block';

            console.log('Firma limpiada');
        }

        // ==================== FUNCIONES PARA TÉRMINOS Y PREVIEW ====================

        /**
         * Abre el modal de preview del documento
         */
        openDocumentPreview() {
            const plantilla = this.config.plantillaContratos;
            if (!plantilla) {
                console.error('No hay plantilla de contrato disponible');
                return;
            }

            // Renderizar el contenido del documento
            this.renderDocumentPreview();

            // Mostrar el modal
            const overlay = document.getElementById('sacs-preview-overlay');
            if (overlay) {
                overlay.classList.add('active');
            }
        }

        /**
         * Cierra el modal de preview del documento
         */
        closeDocumentPreview() {
            const overlay = document.getElementById('sacs-preview-overlay');
            if (overlay) {
                overlay.classList.remove('active');
            }
        }

        /**
         * Renderiza el contenido del documento en el modal de preview
         */
        renderDocumentPreview() {
            const plantilla = this.config.plantillaContratos || {};
            const contenido = plantilla.contenidoInfo || {};
            const config = plantilla.config || {};
            const general = config.general || {};
            const empresaInfo = plantilla.empresaInfo || {};
            const clienteInfo = {
                ...this.customerInfo,
                email: this.customerInfo?.correo || this.customerInfo?.email || '',
                telefono: this.customerInfo?.telefono || this.customerInfo?.phone || ''
            };

            let html = '';

            // Header del documento
            html += '<div class="doc-header">';
            if (general.incluirLogo && general.logoUrl) {
                html += '<div class="doc-logo"><img src="' + general.logoUrl + '" alt="Logo"></div>';
            }
            html += '<h2 class="doc-company-name">' + (empresaInfo.nombre || 'Empresa') + '</h2>';
            html += '<div class="doc-empresa-info">';
            if (empresaInfo.rfc) html += '<p><strong>RFC:</strong> ' + empresaInfo.rfc + '</p>';
            if (empresaInfo.direccion) html += '<p><strong>Dirección:</strong> ' + empresaInfo.direccion + '</p>';
            if (empresaInfo.telefono) html += '<p><strong>Tel:</strong> ' + empresaInfo.telefono + '</p>';
            html += '</div>';
            html += '</div>';

            // Título y subtítulo
            html += '<h1 class="doc-title">' + (contenido.titulo || plantilla.nombre || 'Documento') + '</h1>';
            if (contenido.subtitulo) {
                html += '<p class="doc-subtitle">' + contenido.subtitulo + '</p>';
            }

            // Texto introductorio
            if (contenido.textoIntroductorio) {
                html += '<p class="doc-text">' + this.procesarTextoContrato(contenido.textoIntroductorio, clienteInfo, empresaInfo) + '</p>';
            }

            // Texto de aceptación
            if (contenido.textoAceptacion) {
                html += '<p class="doc-text"><strong>' + this.procesarTextoContrato(contenido.textoAceptacion, clienteInfo, empresaInfo) + '</strong></p>';
            }

            // Cláusulas
            if (plantilla.clausulas && plantilla.clausulas.length > 0) {
                html += '<div class="doc-section">';
                html += '<h3 class="doc-section-title">Cláusulas</h3>';
                plantilla.clausulas.forEach((clausula, index) => {
                    html += '<div class="doc-clausula">';
                    html += '<div class="doc-clausula-header">';
                    html += '<span class="doc-clausula-numero">' + (index + 1) + '.</span>';
                    if (clausula.categoria) {
                        html += '<span class="doc-clausula-categoria">' + clausula.categoria + '</span>';
                    }
                    html += '</div>';
                    html += '<p class="doc-clausula-texto">' + this.procesarTextoContrato(clausula.texto, clienteInfo, empresaInfo) + '</p>';
                    html += '</div>';
                });
                html += '</div>';
            }

            // Campos dinámicos
            if (plantilla.camposDinamicos && plantilla.camposDinamicos.length > 0) {
                html += '<div class="doc-section">';
                html += '<h3 class="doc-section-title">Datos del Participante</h3>';
                html += '<div class="doc-fields">';
                plantilla.camposDinamicos.forEach(campo => {
                    html += '<div class="doc-field">';
                    html += '<p class="doc-field-label">' + campo.nombre + '</p>';
                    html += '<p class="doc-field-value">' + this.getCampoValor(campo, clienteInfo) + '</p>';
                    html += '</div>';
                });
                html += '</div>';
                html += '</div>';
            }

            // Información del cliente (si no hay campos dinámicos)
            if (!plantilla.camposDinamicos || plantilla.camposDinamicos.length === 0) {
                html += '<div class="doc-client-info">';
                html += '<p><strong>Cliente:</strong> ' + (clienteInfo.nombre || 'No especificado') + '</p>';
                if (clienteInfo.email) html += '<p><strong>Email:</strong> ' + clienteInfo.email + '</p>';
                if (clienteInfo.telefono) html += '<p><strong>Teléfono:</strong> ' + clienteInfo.telefono + '</p>';
                html += '<p><strong>Fecha:</strong> ' + new Date().toLocaleDateString('es-MX', {
                    year: 'numeric',
                    month: 'long',
                    day: 'numeric'
                }) + '</p>';
                html += '</div>';
            }

            // Sección de firma
            if (general.requiereFirma !== false) {
                html += '<div class="signature-section">';
                html += '<h3 class="doc-section-title">Firma del Participante</h3>';
                html += '<div class="signature-box">';
                html += '<p class="signature-placeholder">Espacio para firma digital</p>';
                html += '</div>';
                html += '</div>';
            }

            // Texto final
            if (contenido.textoFinal) {
                html += '<p class="doc-text" style="margin-top: 24px; font-style: italic;">' + this.procesarTextoContrato(contenido.textoFinal, clienteInfo, empresaInfo) + '</p>';
            }

            // Footer legal
            const opcionesLegales = general.opcionesLegales || {};
            html += '<div class="doc-footer">';
            if (opcionesLegales.vigenciaDias) {
                html += '<p class="legal-text">Este documento tiene una vigencia de ' + opcionesLegales.vigenciaDias + ' días a partir de la fecha de firma.</p>';
            }
            if (opcionesLegales.proteccionDatos) {
                html += '<p class="legal-text" style="margin-top: 8px;">Los datos personales serán tratados conforme a la política de privacidad.</p>';
            }
            html += '</div>';

            // Insertar el HTML en el modal
            const previewDoc = document.getElementById('sacs-preview-document');
            if (previewDoc) {
                previewDoc.innerHTML = html;
            }
        }

        /**
         * Procesa texto reemplazando variables del contrato
         */
        procesarTextoContrato(texto, clienteInfo, empresaInfo) {
            if (!texto) return '';

            let resultado = texto;
            const fecha = new Date().toLocaleDateString('es-MX', {
                year: 'numeric',
                month: 'long',
                day: 'numeric'
            });

            // Variables fijas del sistema
            const variables = {
                '{{cliente_nombre}}': clienteInfo.nombre || '[Nombre del Cliente]',
                '{{cliente_email}}': clienteInfo.email || '[Email]',
                '{{cliente_telefono}}': clienteInfo.telefono || '[Teléfono]',
                '{{fecha_firma}}': fecha,
                '{nombre_cliente}': clienteInfo.nombre || '[Nombre del Cliente]',
                '{email}': clienteInfo.email || '[Email]',
                '{telefono}': clienteInfo.telefono || '[Teléfono]',
                '{fecha}': fecha,
                '{{nombre}}': clienteInfo.nombre || '[Nombre]',
                '{{email}}': clienteInfo.email || '[Email]',
                '{{telefono}}': clienteInfo.telefono || '[Teléfono]',
                '{{fecha}}': fecha,
                '{{empresa_nombre}}': empresaInfo.nombre || '[Empresa]',
                '{{empresa_rfc}}': empresaInfo.rfc || '[RFC]',
                '{{empresa_direccion}}': empresaInfo.direccion || '[Dirección]',
                '{{empresa_telefono}}': empresaInfo.telefono || '[Tel. Empresa]',
                '{{empresa_email}}': empresaInfo.email || '[Email Empresa]',
                '{empresa}': empresaInfo.nombre || '[Empresa]',
                '{empresa_rfc}': empresaInfo.rfc || '[RFC]'
            };

            // Procesar campos dinámicos de la plantilla
            const plantilla = this.config.plantillaContratos || {};
            const camposDinamicos = plantilla.camposDinamicos || [];

            if (camposDinamicos.length > 0) {
                camposDinamicos.forEach(campo => {
                    if (!campo || !campo.nombre) return;

                    const valor = this._getCampoValueFromCliente(campo, clienteInfo) || '[' + campo.nombre + ']';

                    // Usar campo.nombre (ej: "NOMBRE COMPLETO") para generar la variable
                    // Generar variable con nombre exacto (respetando mayúsculas y espacios)
                    const varExacta = '{{' + campo.nombre + '}}';
                    variables[varExacta] = valor;

                    // Generar variable normalizada (minúsculas, sin acentos, guiones bajos)
                    const nombreNormalizado = this._normalizarNombreVariable(campo.nombre);
                    const varNormalizada = '{{' + nombreNormalizado + '}}';
                    if (varNormalizada !== varExacta) {
                        variables[varNormalizada] = valor;
                    }

                    // Retrocompatibilidad con llave simple
                    const varSimpleExacta = '{' + campo.nombre + '}';
                    variables[varSimpleExacta] = valor;

                    const varSimpleNormalizada = '{' + nombreNormalizado + '}';
                    if (varSimpleNormalizada !== varSimpleExacta) {
                        variables[varSimpleNormalizada] = valor;
                    }
                });
            }

            // Reemplazar todas las variables
            for (const [variable, valor] of Object.entries(variables)) {
                resultado = resultado.split(variable).join(valor);
            }

            return resultado;
        }

        /**
         * Normaliza el nombre de una variable (quita acentos, espacios, etc.)
         */
        _normalizarNombreVariable(nombre) {
            if (!nombre) return '';
            return nombre
                .toLowerCase()
                .normalize("NFD").replace(/[\u0300-\u036f]/g, "")  // Quitar acentos
                .replace(/[^a-z0-9]+/g, '_')                        // Reemplazar no-alfanuméricos con _
                .replace(/^_+|_+$/g, '');                           // Quitar _ al inicio/fin
        }

        /**
         * Obtiene el valor de un campo dinámico desde la info del cliente
         */
        _getCampoValueFromCliente(campo, clienteInfo) {
            if (!campo || !clienteInfo) return null;

            // Si la fuente es 'cliente', buscar en el objeto clienteInfo
            if (campo.fuente === 'cliente' && campo.campoCliente) {
                // Mapeo de campos comunes
                const mapeoCliente = {
                    'name': clienteInfo.nombre || clienteInfo.name,
                    'nombre': clienteInfo.nombre || clienteInfo.name,
                    'email': clienteInfo.email,
                    'phone': clienteInfo.telefono || clienteInfo.phone,
                    'telefono': clienteInfo.telefono || clienteInfo.phone
                };

                return mapeoCliente[campo.campoCliente] || clienteInfo[campo.campoCliente] || campo.valorPrueba;
            }

            // Si la fuente es 'sistema' y es tipo fecha
            if (campo.fuente === 'sistema' && campo.tipo === 'fecha') {
                return new Date().toLocaleDateString('es-MX', {
                    year: 'numeric',
                    month: 'long',
                    day: 'numeric'
                });
            }

            // Para otros casos, usar valorPrueba
            return campo.valorPrueba || null;
        }

        /**
         * Obtiene el valor de un campo dinámico (usa _getCampoValueFromCliente internamente)
         */
        getCampoValor(campo, clienteInfo) {
            if (!campo) return '';
            return this._getCampoValueFromCliente(campo, clienteInfo) || '[Sin datos]';
        }

        /**
         * Maneja el cambio del checkbox de términos
         */
        onTermsChange() {
            console.log('📋 onTermsChange llamado en instancia:', this.instanceId);
            const checkbox = document.getElementById(`sacs-terms-checkbox-${this.instanceId}`);
            console.log('   - checkbox encontrado:', !!checkbox);
            console.log('   - checkbox.checked:', checkbox?.checked);
            this.termsAccepted = checkbox ? checkbox.checked : false;
            console.log('   - this.termsAccepted seteado a:', this.termsAccepted);
            this.updateConfirmButtonState();
        }

        /**
         * Actualiza el estado del botón de confirmar firma
         * Requiere: firma dibujada + términos aceptados
         */
        updateConfirmButtonState() {
            const btnConfirmar = document.getElementById(`sacs-confirmar-firma-btn-${this.instanceId}`);
            console.log('🔄 updateConfirmButtonState llamado para instancia:', this.instanceId);
            console.log('   - firmaDibujada:', this.firmaDibujada);
            console.log('   - termsAccepted:', this.termsAccepted);
            console.log('   - btnConfirmar encontrado:', !!btnConfirmar);
            if (btnConfirmar) {
                const shouldEnable = this.firmaDibujada && this.termsAccepted;
                console.log('   - shouldEnable:', shouldEnable);
                btnConfirmar.disabled = !shouldEnable;
                console.log('   - btnConfirmar.disabled:', btnConfirmar.disabled);
            }
        }

        // ==================== FIN FUNCIONES PARA TÉRMINOS Y PREVIEW ====================

        async confirmarFirma() {
            if (!this.firmaDibujada) {
                console.error('No hay firma dibujada');
                return;
            }

            if (!this.termsAccepted) {
                console.error('Los términos no han sido aceptados');
                return;
            }

            // Convertir canvas a base64
            const canvas = document.getElementById(`sacs-signature-canvas-${this.instanceId}`);
            this.firmaBase64 = canvas.toDataURL('image/png');

            console.log('✓ Firma capturada:', this.firmaBase64.substring(0, 50) + '...');
            console.log('✓ Términos aceptados');

            // Ir al paso 4 (Pago)
            this.goToStep(4);
        }

        volverDesdePago() {
            const requiereFirma = this.requiereFirma();

            if (requiereFirma) {
                // Si tiene firma, volver al paso 3 (firma)
                this.goToStep(3);
            } else {
                // Si NO tiene firma, volver al paso 2 (info cliente)
                this.goToStep(2);
            }
        }

        async processPaymentWithSignature() {
            try {
                console.log('Creando pedido con firma...');

                // Crear pedido CON firma
                await this.createOrder(
                    this.paymentIntentId,
                    'succeeded',
                    this.paymentTotal,
                    this.firmaBase64  // ← Firma capturada
                );

                // Ir a confirmación (paso 5)
                this.currentStep = 5;
                this.render();

            } catch (orderError) {
                // El pago fue exitoso pero falló la creación del pedido
                console.error('❌ Pago exitoso pero error al crear pedido con firma:', orderError);

                // Guardar error para mostrarlo
                this.paymentError = orderError;

                // Ir a pantalla de error especial (paso 99)
                this.currentStep = 99;
                this.render();
            }
        }

        // ==================== FIN MÉTODOS DEL CANVAS DE FIRMA ====================

        async processPayment() {
            const btnText = document.getElementById('sacs-btn-text');
            const btnSpinner = document.getElementById('sacs-btn-spinner');
            const payBtn = document.getElementById('sacs-pay-btn');
            const errorContainer = document.getElementById('sacs-error-container');

            // Validar que la info del cliente ya esté capturada (desde paso 2)
            if (!this.validateCustomerInfo()) {
                this.showError('Error: Información del cliente no encontrada');
                return;
            }

            // Mostrar spinner
            payBtn.disabled = true;
            btnText.style.display = 'none';
            btnSpinner.style.display = 'block';
            errorContainer.innerHTML = '';

            try {
                const total = this.calculateTotal();

                // 1. Crear Payment Intent
                const productsSimplified = this.cart.map(item => ({
                    nombre: item.nombre,
                    cantidad: item.quantity,
                    precio: item.precio
                }));

                const response = await fetch(`${SACS_API_URL}/stripe/${this.config.accountId}/create-payment`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        amount: Math.round(total * 100),
                        currency: 'mxn',
                        description: 'Compra en tienda online',
                        metadata: {
                            customer_name: this.customerInfo.nombre,
                            customer_email: this.customerInfo.correo,
                            products: JSON.stringify(productsSimplified)
                        }
                    })
                });

                const paymentData = await response.json();

                if (!response.ok || !paymentData.success) {
                    throw new Error(paymentData.error || 'Error al crear el pago');
                }

                // 2. Confirmar pago con Stripe
                const { error, paymentIntent } = await this.stripe.confirmCardPayment(
                    paymentData.clientSecret,
                    {
                        payment_method: {
                            card: this.cardElement,
                            billing_details: {
                                name: this.customerInfo.nombre,
                                email: this.customerInfo.correo,
                                address: {
                                    line1: this.customerInfo.direccion,
                                    city: this.customerInfo.ciudad,
                                    postal_code: this.customerInfo.codigoPostal
                                }
                            }
                        }
                    }
                );

                if (error) {
                    throw new Error(error.message);
                }

                // 3. Guardar order ID temporal y total
                this.orderId = paymentIntent.id.substring(3).toUpperCase();
                this.paymentTotal = total;

                // 4. Crear pedido con o sin firma
                try {
                    if (this.firmaBase64) {
                        // CON FIRMA: Ya capturada en paso 3
                        console.log('✓ Pago exitoso - Crear pedido CON firma');
                        await this.createOrder(paymentIntent.id, 'succeeded', total, this.firmaBase64);
                    } else {
                        // SIN FIRMA
                        console.log('✓ Pago exitoso - Crear pedido SIN firma');
                        await this.createOrder(paymentIntent.id, 'succeeded', total, null);
                    }

                    // 5. Si todo salió bien, ir a confirmación (paso 5)
                    this.currentStep = 5;
                    this.render();

                } catch (orderError) {
                    // El pago fue exitoso pero falló la creación del pedido
                    console.error('❌ Pago exitoso pero error al crear pedido:', orderError);

                    // Guardar error para mostrarlo
                    this.paymentError = orderError;

                    // Ir a pantalla de error especial (paso 99)
                    this.currentStep = 99;
                    this.render();

                    // Re-habilitar botón por si el usuario quiere cerrar
                    payBtn.disabled = false;
                    btnText.style.display = 'block';
                    btnSpinner.style.display = 'none';
                }

            } catch (error) {
                console.error('Error en el pago:', error);
                this.showError(error.message || 'Ocurrió un error al procesar el pago');

                payBtn.disabled = false;
                btnText.style.display = 'block';
                btnSpinner.style.display = 'none';
            }
        }

        async createOrder(paymentIntentId, paymentStatus, total, firmaBase64 = null) {
            const API_URL = 'https://sacs-api-819604817289.us-central1.run.app/v1';

            try {
                const now = Date.now();
                const fecha = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
                const hora = new Date().toTimeString().split(' ')[0]; // HH:MM:SS

                // Calcular subtotal sin IVA (16%)
                const subtotal = total / 1.16;
                const impuestosTotal = total - subtotal;

                // Validar que existan los account defaults
                if (!this.config.accountDefaults) {
                    throw new Error('No se encontró la configuración de la cuenta (accountDefaults)');
                }

                const defaults = this.config.accountDefaults;

                if (!defaults.almacen?.key) {
                    throw new Error('No se encontró el almacén en accountDefaults');
                }

                if (!defaults.sucursal?.key) {
                    throw new Error('No se encontró la sucursal en accountDefaults');
                }

                if (!defaults.tipoCliente?.key) {
                    throw new Error('No se encontró el tipo de cliente en accountDefaults');
                }

                // Construir header del pedido
                const header = {
                    fecha: fecha,
                    hora: hora,
                    tipo_cambio: 0,
                    tipo_cambio_dia: 0,
                    descuento: 0,
                    descuento_porcentaje_nota: 0,
                    descuento_importe_nota: 0,
                    descuentoImporteConImpuestos: 0,
                    descuento_razon: "",
                    tipo_descuento: "importe",
                    subtotal: subtotal,
                    tipo_de_envio: "gratis",
                    envio_tarifa_nombre: "",
                    envio_tarifa_importe: 0,
                    total: total,
                    totalImpuestos: total,
                    almacen: defaults.almacen.key,
                    almacennombre: defaults.almacen.name,
                    sucursal: defaults.sucursal.key,
                    sucursalnombre: defaults.sucursal.name,
                    cliente: null,
                    clientenombre: this.customerInfo.nombre,
                    clientetelefono: this.customerInfo.telefono || "",
                    clientecorreo: this.customerInfo.correo,
                    clientecalle: this.customerInfo.direccion || "",
                    clienteexterior: "",
                    clienteinterior: "",
                    clientecodigo: this.customerInfo.codigoPostal || "",
                    clientereferencia: "",
                    clientecolonia: "",
                    clientemunicipio: this.customerInfo.ciudad || "",
                    clienteestado: "",
                    clientepais: "México",
                    clientetipo: defaults.tipoCliente.key,
                    moneda: "-L21_TTrh_MTKO07LXSp",
                    moneda_nomenclatura: "MXN",
                    moneda_default: "-L21_TTrh_MTKO07LXSp",
                    moneda_prefijo: "$",
                    status: "Abierto",
                    statusPago: paymentStatus === 'succeeded' ? "Pagado" : "Pendiente",
                    statusPreparado: "No preparado",
                    canal: "Online - eCommerce Widget",
                    articulos: `${this.cart.length} articulos`,
                    uid: "-OUjfwh092oLaxFt0_T1",
                    username: "Widget eCommerce",
                    delivery_method: 'pickup',
                    comentarios: "Pedido realizado a través del widget embebido de eCommerce",
                    metodo_pago: 'stripe',
                    stripe_payment_intent_id: paymentIntentId,
                    stripe_payment_status: paymentStatus
                };

                // Construir details del pedido usando los productos completos de MongoDB
                const details = this.cart.map(item => {
                    const cantidad = Number(item.quantity);
                    const precioUnitario = Number(item.precio);
                    const costoUnitario = Number(item.costo) || 0; // Usar 0 si no viene costo
                    const valorImpuesto = Number(item.valorimpuesto) / 100; // Convertir porcentaje a decimal

                    // Cálculos financieros (igual que fashion-forward)
                    const precioSinImpuesto = precioUnitario / (1 + valorImpuesto);
                    const importeSinImpuesto = precioSinImpuesto * cantidad;
                    const impuestoImporte = importeSinImpuesto * valorImpuesto;
                    const importeConImpuesto = importeSinImpuesto + impuestoImporte;

                    // Usar TODO el producto tal como viene de MongoDB
                    return {
                        // CAMPOS OBLIGATORIOS
                        id_producto: item.fid,
                        costo: costoUnitario,
                        cantidad: cantidad,
                        tipo: item.tipo,
                        fid: item.fid,

                        // CAMPOS DEL ARTÍCULO COMPLETO (usar los campos originales)
                        code: item.code || "",
                        nombre: item.nombre,
                        sku: item.sku || "",
                        precio: precioSinImpuesto, // SIN impuestos
                        precio_original: Number(item.precio_original || item.precio),
                        precio_carrito: Number(item.precio_carrito || item.precio),

                        // RELACIONES (usar los campos originales del producto)
                        proveedor: item.proveedor || "",
                        nombreproveedor: item.nombreproveedor || "",
                        categoria: item.categoria || "",
                        nombrecategoria: item.nombrecategoria || "",
                        marca: item.marca || "",
                        nombremarca: item.nombremarca || "",
                        unidad: item.unidad,
                        unidadclave: item.unidadclave,
                        unidadnombre: item.unidadnombre,

                        // MONEDA E IMPUESTOS (usar los campos originales)
                        moneda: item.moneda,
                        nombremoneda: item.nombremoneda || "MXN",
                        moneda_original: item.moneda_original || item.moneda,
                        impuestos: item.impuestos,
                        nombreimpuestos: item.nombreimpuestos,
                        valorimpuesto: Number(item.valorimpuesto),

                        // CÁLCULOS FINANCIEROS
                        importe: importeSinImpuesto,
                        importe_con_impuestos: importeConImpuesto,
                        impuesto_importe: impuestoImporte,
                        total_impuesto: impuestoImporte,

                        // OTROS CAMPOS
                        variante: item.variant || "",
                        descuento_importe: 0,
                        descuento_porcentaje: 0,
                        uid: "-OUjfwh092oLaxFt0_T1"
                    };
                });

                // Construir array de cobros (solo si es pago con Stripe exitoso)
                const cobros = [];

                if (paymentStatus === 'succeeded') {
                    cobros.push({
                        account: this.config.accountId,
                        metodo: 'Stripe',
                        importe: total,
                        moneda: header.moneda,
                        tipo_cambio: 1,
                        fecha: fecha,
                        hora: hora,
                        created: now,
                        modified: now,
                        datetime: now,
                        timestamp: now,
                        // Campos adicionales de Stripe
                        stripe_payment_intent_id: paymentIntentId,
                        stripe_payment_status: paymentStatus,
                        // Campos de lealtad (se inicializan en 0, el backend los procesará)
                        lealtad_puntos_anteriores: 0,
                        lealtad_puntos_generados: 0,
                        lealtad_puntos_consumidos: 0,
                        lealtad_puntos_actuales: 0,
                        lealtad_puntos_fijos_anteriores: 0,
                        lealtad_puntos_fijos_generados: 0,
                        lealtad_puntos_fijos_consumidos: 0,
                        lealtad_puntos_fijos_actuales: 0
                    });
                }

                // Crear el pedido
                const pedidoObject = {
                    account: this.config.accountId,
                    header: header,
                    details: details,
                    cobros: cobros
                };

                // 🔥 AGREGAR FIRMA SI EXISTE 🔥
                if (firmaBase64) {
                    pedidoObject.firmaBase64 = firmaBase64;
                    console.log('📦 Creando pedido en SACS CON FIRMA:', {
                        ...pedidoObject,
                        firmaBase64: firmaBase64.substring(0, 50) + '...'
                    });
                } else {
                    console.log('📦 Creando pedido en SACS (sin firma):', pedidoObject);
                }

                const response = await fetch(`${API_URL}/pedidos/createPedido`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify(pedidoObject)
                });

                if (!response.ok) {
                    throw new Error(`Error ${response.status}: ${response.statusText}`);
                }

                const result = await response.json();

                if (result.success) {
                    console.log('✓ Pedido creado exitosamente:', result);
                    // Actualizar el orderId con el folio real del pedido
                    // El folio viene en result.data.folio (estructura del API)
                    const folio = result.data?.folio || result.folio;
                    if (folio) {
                        this.orderId = `PED-${folio}`;

                        // 📧 Enviar correo de confirmación al cliente (no bloqueante)
                        this.sendOrderEmail(folio).catch(err => {
                            console.warn('⚠️ No se pudo enviar correo de confirmación:', err);
                        });

                        return { success: true, folio: folio };
                    }
                } else {
                    console.error('Error al crear pedido:', result.message || result.msg);
                    // Retornar el error para que el flujo superior lo maneje
                    throw new Error(result.message || result.msg || 'Error desconocido al crear el pedido');
                }

            } catch (error) {
                console.error('Error creando pedido:', error);
                // Retornar el error con el paymentIntentId para rastreo
                throw {
                    message: error.message || 'Error al comunicarse con el servidor',
                    paymentIntentId: paymentIntentId,
                    details: error.toString()
                };
            }
        }

        validateCustomerInfo() {
            return this.customerInfo.correo &&
                   this.customerInfo.nombre &&
                   this.customerInfo.direccion &&
                   this.customerInfo.ciudad &&
                   this.customerInfo.codigoPostal;
        }

        // ==================== FUNCIONES PARA ENVÍO DE CORREO DE CONFIRMACIÓN ====================

        /**
         * Obtiene el logo de la sucursal desde MongoDB
         */
        async getSucursalLogo(accountId, sucursalFid) {
            const API_URL = 'https://api.sacscloud.com/v1';

            try {
                const response = await fetch(`${API_URL}/rest/${accountId}/sucursales/aggregate`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        pipeline: [
                            { $match: { fid: sucursalFid } },
                            { $project: { logo: 1 } },
                            { $limit: 1 }
                        ]
                    })
                });

                const result = await response.json();

                if (result.success && Array.isArray(result.data) && result.data.length > 0) {
                    return result.data[0].logo || null;
                }
                return null;
            } catch (error) {
                console.warn('⚠️ No se pudo obtener logo de sucursal:', error);
                return null;
            }
        }

        /**
         * Envía correo de confirmación del pedido al cliente
         */
        async sendOrderEmail(folio) {
            try {
                const API_URL = 'https://api.sacscloud.com/v1';
                const branding = this.config.branding || {};
                const storeName = branding.storeName || this.config.ecommerceConfig?.nombreTienda || 'Tienda Online';
                const logoUrl = branding.logo || null;
                const coverUrl = branding.coverImage || null;

                const htmlContent = this.generateOrderEmailHTML(folio, storeName, logoUrl, coverUrl);

                const emailData = {
                    to: this.customerInfo.correo,
                    subject: `Confirmación de pedido #${folio} - ${storeName}`,
                    htmlContent: htmlContent
                };

                console.log('📧 Enviando correo de confirmación a:', this.customerInfo.correo);

                const response = await fetch(`${API_URL}/email/sendgrid`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify(emailData)
                });

                if (!response.ok) {
                    throw new Error(`Error ${response.status}: ${response.statusText}`);
                }

                const result = await response.json();
                console.log('✅ Correo de confirmación enviado:', result);
                return result;

            } catch (error) {
                console.error('❌ Error enviando correo de confirmación:', error);
                // No lanzar error para no afectar el flujo del pedido
                return { success: false, error: error.message };
            }
        }

        /**
         * Genera el HTML del correo de confirmación
         */
        generateOrderEmailHTML(folio, storeName, logoUrl, coverUrl) {
            const total = this.calculateTotal();
            const subtotal = total / 1.16;
            const impuestos = total - subtotal;
            const fecha = new Date().toLocaleDateString('es-MX', {
                year: 'numeric',
                month: 'long',
                day: 'numeric'
            });
            const hora = new Date().toLocaleTimeString('es-MX', {
                hour: '2-digit',
                minute: '2-digit'
            });

            // Generar filas de productos
            const productosHTML = this.cart.map(item => {
                const precioUnitario = Number(item.precio);
                const cantidad = Number(item.quantity);
                const importeTotal = precioUnitario * cantidad;
                return `
                    <tr>
                        <td style="padding: 12px; border-bottom: 1px solid #e5e7eb;">${item.nombre}</td>
                        <td style="padding: 12px; border-bottom: 1px solid #e5e7eb; text-align: center;">${cantidad}</td>
                        <td style="padding: 12px; border-bottom: 1px solid #e5e7eb; text-align: right;">$${precioUnitario.toFixed(2)}</td>
                        <td style="padding: 12px; border-bottom: 1px solid #e5e7eb; text-align: right; font-weight: 600; color: #059669;">$${importeTotal.toFixed(2)}</td>
                    </tr>
                `;
            }).join('');

            // Header con cover o gradiente por defecto
            const headerStyle = coverUrl
                ? `background: linear-gradient(rgba(0,0,0,0.5), rgba(0,0,0,0.6)), url('${coverUrl}'); background-size: cover; background-position: center;`
                : `background: linear-gradient(135deg, #6366f1 0%, #4f46e5 100%);`;

            return `
<!DOCTYPE html>
<html lang="es">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Confirmación de Pedido #${folio}</title>
</head>
<body style="margin: 0; padding: 20px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #f3f4f6; line-height: 1.6;">
    <div style="max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);">

        <!-- Header con Cover y Logo -->
        <div style="${headerStyle} padding: 40px 30px; text-align: center;">
            ${logoUrl ? `
            <div style="background: rgba(255,255,255,0.95); border-radius: 12px; padding: 15px 25px; display: inline-block; margin-bottom: 20px; box-shadow: 0 4px 15px rgba(0,0,0,0.2);">
                <img src="${logoUrl}" alt="${storeName}" style="max-height: 50px; max-width: 180px; display: block;">
            </div>
            ` : ''}
            <h1 style="margin: 0; color: #ffffff; font-size: 28px; font-weight: 700; text-shadow: 0 2px 4px rgba(0,0,0,0.3);">¡Pedido Confirmado!</h1>
            <p style="margin: 10px 0 0 0; color: rgba(255,255,255,0.95); font-size: 16px; text-shadow: 0 1px 2px rgba(0,0,0,0.3);">Gracias por tu compra, ${this.customerInfo.nombre}</p>
        </div>

        <!-- Contenido -->
        <div style="padding: 30px;">

            <!-- Número de pedido destacado con QR y Código de Barras -->
            <div style="background: linear-gradient(135deg, #f0fdf4 0%, #dcfce7 100%); border: 2px solid #22c55e; border-radius: 12px; padding: 25px; text-align: center; margin-bottom: 30px;">
                <p style="margin: 0 0 5px 0; color: #166534; font-size: 14px; text-transform: uppercase; letter-spacing: 1px;">Número de Pedido</p>
                <h2 style="margin: 0; color: #15803d; font-size: 36px; font-weight: 700;">#${folio}</h2>
                <p style="margin: 10px 0 0 0; color: #166534; font-size: 14px;">Guarda este número para recoger tu pedido</p>

                <!-- QR Code -->
                <div style="margin-top: 20px;">
                    <img src="https://api.qrserver.com/v1/create-qr-code/?size=150x150&data=${encodeURIComponent('Pedido: ' + folio + ' | Total: $' + total.toFixed(2) + ' | ' + storeName)}"
                         alt="QR Pedido ${folio}"
                         style="width: 150px; height: 150px; border-radius: 8px; background: white; padding: 8px;">
                </div>

                <!-- Código de Barras -->
                <div style="margin-top: 15px;">
                    <img src="https://barcodeapi.org/api/128/${folio}"
                         alt="Código de barras ${folio}"
                         style="max-width: 200px; height: auto; background: white; padding: 8px; border-radius: 4px;">
                </div>

                <p style="margin: 15px 0 0 0; color: #166534; font-size: 12px;">Presenta cualquiera de estos códigos al recoger tu pedido</p>
            </div>

            <!-- Info del pedido -->
            <div style="background-color: #f9fafb; border-radius: 8px; padding: 20px; margin-bottom: 25px;">
                <h3 style="margin: 0 0 15px 0; color: #374151; font-size: 16px;">📋 Información del Pedido</h3>
                <table style="width: 100%;">
                    <tr>
                        <td style="padding: 8px 0; color: #6b7280;">Fecha:</td>
                        <td style="padding: 8px 0; color: #111827; text-align: right;">${fecha}</td>
                    </tr>
                    <tr>
                        <td style="padding: 8px 0; color: #6b7280;">Hora:</td>
                        <td style="padding: 8px 0; color: #111827; text-align: right;">${hora}</td>
                    </tr>
                    <tr>
                        <td style="padding: 8px 0; color: #6b7280;">Cliente:</td>
                        <td style="padding: 8px 0; color: #111827; text-align: right;">${this.customerInfo.nombre}</td>
                    </tr>
                    <tr>
                        <td style="padding: 8px 0; color: #6b7280;">Email:</td>
                        <td style="padding: 8px 0; color: #111827; text-align: right;">${this.customerInfo.correo}</td>
                    </tr>
                </table>
            </div>

            <!-- Productos -->
            <h3 style="margin: 0 0 15px 0; color: #374151; font-size: 16px;">🛍️ Productos</h3>
            <table style="width: 100%; border-collapse: collapse; margin-bottom: 25px;">
                <thead>
                    <tr style="background-color: #f3f4f6;">
                        <th style="padding: 12px; text-align: left; color: #374151; font-weight: 600;">Producto</th>
                        <th style="padding: 12px; text-align: center; color: #374151; font-weight: 600;">Cant.</th>
                        <th style="padding: 12px; text-align: right; color: #374151; font-weight: 600;">Precio</th>
                        <th style="padding: 12px; text-align: right; color: #374151; font-weight: 600;">Total</th>
                    </tr>
                </thead>
                <tbody>
                    ${productosHTML}
                </tbody>
            </table>

            <!-- Totales -->
            <div style="background-color: #f9fafb; border-radius: 8px; padding: 20px;">
                <table style="width: 100%;">
                    <tr>
                        <td style="padding: 8px 0; color: #6b7280;">Subtotal:</td>
                        <td style="padding: 8px 0; color: #111827; text-align: right;">$${subtotal.toFixed(2)}</td>
                    </tr>
                    <tr>
                        <td style="padding: 8px 0; color: #6b7280;">IVA (16%):</td>
                        <td style="padding: 8px 0; color: #111827; text-align: right;">$${impuestos.toFixed(2)}</td>
                    </tr>
                    <tr style="border-top: 2px solid #e5e7eb;">
                        <td style="padding: 15px 0 8px 0; color: #111827; font-size: 18px; font-weight: 700;">Total:</td>
                        <td style="padding: 15px 0 8px 0; color: #059669; font-size: 18px; font-weight: 700; text-align: right;">$${total.toFixed(2)}</td>
                    </tr>
                </table>
            </div>

            <!-- Instrucciones -->
            <div style="margin-top: 30px; padding: 20px; background-color: #eff6ff; border-radius: 8px; border-left: 4px solid #3b82f6;">
                <h3 style="margin: 0 0 10px 0; color: #1e40af; font-size: 16px;">📍 ¿Cómo recoger tu pedido?</h3>
                <p style="margin: 0; color: #1e3a8a; font-size: 14px;">
                    Presenta este número de pedido <strong>#${folio}</strong> al cajero para completar tu compra.
                    Puedes mostrar este correo o mencionar el folio.
                </p>
            </div>

        </div>

        <!-- Footer -->
        <div style="background-color: #1f2937; padding: 25px 30px; text-align: center;">
            <p style="margin: 0 0 5px 0; color: #ffffff; font-size: 14px;">Gracias por tu preferencia</p>
            <p style="margin: 0; color: rgba(255,255,255,0.7); font-size: 13px;">${storeName}</p>
        </div>

    </div>
</body>
</html>
            `;
        }

        // ==================== FIN FUNCIONES PARA ENVÍO DE CORREO ====================

        showError(message) {
            const errorContainer = document.getElementById('sacs-error-container');
            if (errorContainer) {
                errorContainer.innerHTML = `<div class="sacs-error-message">${message}</div>`;
            }
        }
    }

    // Exponer API global con soporte para múltiples instancias
    window.sacsCheckout = {
        instances: {},  // Cambiado a objeto para acceso por ID

        /**
         * Inicializa una nueva instancia del checkout
         * @param {Object} options - Opciones de configuración
         * @param {string} options.accountId - ID de la cuenta SACS (requerido)
         * @param {string} options.configId - ID de la configuración de ecommerce
         * @param {string} options.containerId - ID único del contenedor (para múltiples botones)
         * @param {boolean} options.renderButton - Si es false, no crea botón (default: true)
         * @returns {SacsCheckout} Instancia del checkout con método open()
         *
         * @example
         * // Uso básico (crea botón automáticamente)
         * sacsCheckout.init({ accountId: 'xxx', configId: 'yyy' });
         *
         * @example
         * // Sin botón - usar botón nativo del CMS
         * var checkout = await sacsCheckout.init({
         *   accountId: 'xxx',
         *   configId: 'yyy',
         *   renderButton: false
         * });
         * document.getElementById('mi-boton-cms').onclick = () => checkout.open();
         *
         * @example
         * // Múltiples botones en la misma página
         * sacsCheckout.init({ accountId: 'xxx', configId: 'config1', containerId: 'checkout-1' });
         * sacsCheckout.init({ accountId: 'xxx', configId: 'config2', containerId: 'checkout-2' });
         */
        async init(options) {
            const instance = new SacsCheckout();
            await instance.init(options);

            // Guardar instancia por containerId o configId para acceso posterior
            const key = options.containerId || options.configId || instance.instanceId;
            this.instances[key] = instance;

            console.log(`✅ Instancia creada: ${key}`);
            return instance;
        },

        /**
         * Obtiene una instancia existente por su containerId o configId
         * @param {string} id - containerId o configId de la instancia
         * @returns {SacsCheckout|null} La instancia o null si no existe
         *
         * @example
         * var checkout = sacsCheckout.getInstance('checkout-1');
         * checkout.open();
         */
        getInstance(id) {
            // Primero buscar por key directa (containerId o configId)
            if (this.instances[id]) {
                return this.instances[id];
            }
            // Si no, buscar por instanceId
            for (const key in this.instances) {
                if (this.instances[key].instanceId === id) {
                    return this.instances[key];
                }
            }
            return null;
        },

        /**
         * Obtiene la última instancia creada (para compatibilidad)
         * @returns {SacsCheckout|null}
         */
        _getLastInstance() {
            const keys = Object.keys(this.instances);
            return keys.length > 0 ? this.instances[keys[keys.length - 1]] : null;
        },

        /**
         * Abre el drawer de una instancia específica
         * @param {string} id - containerId o configId de la instancia (opcional, si no se pasa usa la última)
         *
         * @example
         * // Desde un botón del CMS
         * <button onclick="sacsCheckout.open('mi-checkout')">Comprar</button>
         */
        open(id) {
            const instance = id ? this.getInstance(id) : this._getLastInstance();
            if (instance) {
                instance.open();
            } else {
                console.error(`❌ No se encontró instancia${id ? ' con ID: ' + id : ''}`);
            }
        },

        /**
         * Cierra el drawer de una instancia
         * @param {string} id - ID de la instancia (opcional, si no se pasa usa la última)
         */
        close(id) {
            const instance = id ? this.getInstance(id) : this._getLastInstance();
            if (instance) instance.close();
        },

        /**
         * Actualiza la cantidad de un producto en el carrito
         * @param {number} index - Índice del producto
         * @param {number} quantity - Nueva cantidad
         * @param {string} id - ID de la instancia (opcional)
         */
        updateQuantity(index, quantity, id) {
            const instance = id ? this.getInstance(id) : this._getLastInstance();
            if (instance) instance.updateQuantity(index, quantity);
        },

        /**
         * Navega a un paso específico del checkout
         * @param {number} step - Número del paso
         * @param {string} id - ID de la instancia (opcional)
         */
        goToStep(step, id) {
            const instance = id ? this.getInstance(id) : this._getLastInstance();
            if (instance) instance.goToStep(step);
        },

        /**
         * Vuelve desde el paso de pago al carrito
         * @param {string} id - ID de la instancia (opcional)
         */
        volverDesdePago(id) {
            const instance = id ? this.getInstance(id) : this._getLastInstance();
            if (instance) instance.volverDesdePago();
        },

        /**
         * Abre el modal de preview del documento
         * @param {string} id - ID de la instancia (opcional)
         */
        openDocumentPreview(id) {
            const instance = id ? this.getInstance(id) : this._getLastInstance();
            if (instance) instance.openDocumentPreview();
        },

        /**
         * Cierra el modal de preview del documento
         * @param {string} id - ID de la instancia (opcional)
         */
        closeDocumentPreview(id) {
            const instance = id ? this.getInstance(id) : this._getLastInstance();
            if (instance) instance.closeDocumentPreview();
        },

        /**
         * Maneja el cambio del checkbox de términos
         * @param {string} id - ID de la instancia (opcional)
         */
        onTermsChange(id) {
            const instance = id ? this.getInstance(id) : this._getLastInstance();
            if (instance) instance.onTermsChange();
        },

        /**
         * Lista todas las instancias activas
         * @returns {string[]} Array de IDs de instancias
         */
        listInstances() {
            return Object.keys(this.instances);
        }
    };

})(window);
