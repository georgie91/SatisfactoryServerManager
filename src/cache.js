const logger = require("./logger");

const EventEmitter = require('events');

class PageCache extends EventEmitter {

    constructor() {
        super();

        this.AgentList = [];
        this.ActiveAgent = null;
        

    }

    setAgentsList(agentList) {
        this.AgentList = agentList;
        this.setActiveAgent(getCookie("currentAgentId"))
        this.emit("setagentslist");
    }

    getAgentsList() {
        return this.AgentList;
    }



    setActiveAgent(id) {
        if (id == null) {
            return;
        }
        setCookie("currentAgentId", id, 10);
        const Agent = this.getAgentsList().find(agent => agent.id == id);
        this.ActiveAgent = Agent;

        this.emit("setactiveagent");
    }

    getActiveAgent() {
        return this.ActiveAgent;
    }
}

function setCookie(name, value, days) {
    var expires = "";
    if (days) {
        var date = new Date();
        date.setTime(date.getTime() + (days * 24 * 60 * 60 * 1000));
        expires = "; expires=" + date.toUTCString();
    }
    document.cookie = name + "=" + (value || "") + expires + "; path=/";
}

function getCookie(name) {
    var nameEQ = name + "=";
    var ca = document.cookie.split(';');
    for (var i = 0; i < ca.length; i++) {
        var c = ca[i];
        while (c.charAt(0) == ' ') c = c.substring(1, c.length);
        if (c.indexOf(nameEQ) == 0) return c.substring(nameEQ.length, c.length);
    }
    return null;
}

const pageCache = new PageCache();

module.exports = pageCache