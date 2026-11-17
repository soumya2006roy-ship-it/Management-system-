
export class Router {
    constructor(routes) {
        this.routes = routes;
        this.rootElem = document.getElementById('app');
        window.addEventListener('hashchange', () => this.handleRoute());
        this.handleRoute(); 
    }

    handleRoute() {
        const hash = window.location.hash || '#/';
        const route = this.routes[hash] || this.routes[hash.split('?')[0]] || this.routes['404'] || this.routes['#/'];

        if (route) {
            route();
        } else {
            console.error('No route found for', hash);
        }
    }

    navigate(hash) {
        window.location.hash = hash;
    }
}
