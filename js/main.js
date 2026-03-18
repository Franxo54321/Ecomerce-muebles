// Funcionalidad para aceptar cookies
document.querySelector('.btn-accept')?.addEventListener('click', function() {
    document.querySelector('.cookie-notice').style.display = 'none';
    localStorage.setItem('cookiesAccepted', 'true');
});

// Mostrar/ocultar dropdown de navegación
const dropdowns = document.querySelectorAll('.dropdown');
dropdowns.forEach(dropdown => {
    dropdown.addEventListener('mouseenter', function() {
        this.querySelector('.dropdown-content').style.display = 'flex';
    });
    
    dropdown.addEventListener('mouseleave', function() {
        this.querySelector('.dropdown-content').style.display = 'none';
    });
});

// Verificar si ya se aceptaron cookies
if (localStorage.getItem('cookiesAccepted') === 'true') {
    document.querySelector('.cookie-notice')?.style.display = 'none';
}

// Funcionalidad básica del carrito
document.querySelectorAll('.btn-add').forEach(button => {
    button.addEventListener('click', function() {
        const product = this.closest('.product-card');
        const productName = product.querySelector('h3').textContent;
        alert(`"${productName}" agregado al carrito`);
    });
});