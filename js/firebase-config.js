/* =========================================================================
   CONFIGURAÇÃO DO FIREBASE — Monitor de Agências de Turismo
   =========================================================================
   Projeto Firebase próprio e isolado do Educa Bondinho: "monitor-agencias".

   Essas chaves NÃO são secretas — a segurança de verdade vem das "Regras de
   Segurança" do Firestore (configuradas no console), não de esconder essas
   chaves.
   ========================================================================= */

const FIREBASE_CONFIG = {
  apiKey: "AIzaSyD02B4tb9IxPtqObbcy69Ho63XgHEsd9Ds",
  authDomain: "monitor-agencias.firebaseapp.com",
  projectId: "monitor-agencias",
  storageBucket: "monitor-agencias.firebasestorage.app",
  messagingSenderId: "248239312649",
  appId: "1:248239312649:web:0fdc05d8c556593b438dd8",
};

/* -------------------------------------------------------------------------
   TRAVA DE SEGURANÇA ANTI-CONTAMINAÇÃO
   -------------------------------------------------------------------------
   Este projeto (Monitor de Agências) e o Educa Bondinho são propositalmente
   dois projetos Firebase separados, para que um nunca escreva por engano no
   banco de dados do outro. Esta trava confere, em tempo de execução, que o
   projectId carregado é exatamente o esperado — se alguém colar aqui por
   engano a config de outro projeto, o app recusa a conexão e avisa na tela
   em vez de sincronizar dados no lugar errado.
   ------------------------------------------------------------------------- */
const EXPECTED_FIREBASE_PROJECT_ID = "monitor-agencias";

function verifyFirebaseProjectGuard() {
  if (FIREBASE_CONFIG.projectId !== EXPECTED_FIREBASE_PROJECT_ID) {
    const msg = `⚠️ CONFIGURAÇÃO DO FIREBASE INCORRETA: esperado projeto "${EXPECTED_FIREBASE_PROJECT_ID}", encontrado "${FIREBASE_CONFIG.projectId}". Conexão recusada para evitar gravar dados no projeto errado.`;
    console.error(msg);
    document.addEventListener('DOMContentLoaded', () => {
      const banner = document.createElement('div');
      banner.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:99999;background:#d9534f;color:#fff;padding:14px 20px;font-family:sans-serif;font-size:13px;text-align:center;';
      banner.textContent = msg;
      document.body.prepend(banner);
    });
    return false;
  }
  return true;
}

const FIREBASE_PROJECT_GUARD_OK = verifyFirebaseProjectGuard();
