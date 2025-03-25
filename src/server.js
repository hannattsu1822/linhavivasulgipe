const express = require('express');
const path = require('path');
const multer = require('multer');
const xlsx = require('xlsx');
const session = require('express-session');
const mysql = require('mysql2');
const { chromium } = require('playwright');
const cors = require('cors');
const app = express();
const port = 3000;
require('dotenv').config();

// Middleware para processar JSON
app.use(express.json());

// Middleware CORS
app.use(cors());

// Servir arquivos estáticos da pasta "public"
app.use(express.static(path.join(__dirname, '../public')));

// Configuração do multer para upload de arquivos
const upload = multer({ dest: 'uploads/' });

// Configuração de sessões
app.use(session({
  secret: 'sua_chave_secreta',
  resave: false,
  saveUninitialized: true,
  cookie: { secure: false }
}));

// Configuração do pool de conexões MySQL para Railway
const pool = mysql.createPool(process.env.MYSQL_URL || {
  host: 'shortline.proxy.rlwy.net',
  user: 'root',
  password: 'aUhxdnXKYXFdAqepSKQpYcMgUntBvfTa',
  database: 'railway',
  port: 31056,
  ssl: {
    rejectUnauthorized: false
  },
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

// Promisify para usar async/await com MySQL
const promisePool = pool.promise();

// Middleware para verificar conexão com o banco de dados
app.use(async (req, res, next) => {
  try {
    await promisePool.query('SELECT 1');
    next();
  } catch (err) {
    console.error('Erro na conexão com o banco de dados:', err);
    res.status(500).json({ message: 'Erro na conexão com o banco de dados' });
  }
});

// Função para converter Excel Serial Date para data legível
function excelSerialDateToJSDate(serial) {
  const utcDays = Math.floor(serial - 25569);
  const utcValue = utcDays * 86400;
  const date = new Date(utcValue * 1000);
  return date.toISOString().split('T')[0];
}

// Middleware para verificar autenticação
function autenticar(req, res, next) {
  if (req.session.user) {
    req.user = req.session.user;
    next();
  } else {
    res.redirect('/login');
  }
}

// Middleware para verificar permissões por cargo
function verificarPermissaoPorCargo(req, res, next) {
  const cargo = req.user.cargo;
  console.log(`Cargo do usuário: ${cargo}`);
  console.log(`Rota solicitada: ${req.path}`);

  const rotasPublicas = ['/login', '/dashboard'];
  if (rotasPublicas.includes(req.path)) {
    return next();
  }

  const rotasPermitidas = {
    Motorista: ['/frota', '/checklist_veiculos'],
    Inspetor: ['/transformadores', '/upload_transformadores', '/formulario_transformadores'],
    Técnico: ['*'],
    Engenheiro: ['*'],
    ADM: ['*'],
    ADMIN: ['*'],
  };

  const rotasPermitidasUsuario = rotasPermitidas[cargo] || [];
  const rotaPermitida = rotasPermitidasUsuario.some(rota => {
    if (rota === '*') return true;
    return req.path === rota;
  });

  if (!rotaPermitida) {
    console.log('Acesso negado!');
    res.status(403).json({ message: 'Acesso negado!' });
  } else {
    console.log('Acesso permitido!');
    next();
  }
}

// Função para verificar permissão de acesso
function verificarPermissao(req, res, next) {
  const cargo = req.user.cargo;
  const cargosPermitidos = ['Técnico', 'Engenheiro', 'ADMIN'];

  if (cargosPermitidos.includes(cargo)) {
    next();
  } else {
    res.status(403).json({ message: 'Acesso negado!' });
  }
}

// Função para registrar auditoria
async function registrarAuditoria(matricula, acao, detalhes = null) {
  try {
    const query = `
      INSERT INTO auditoria (matricula_usuario, acao, detalhes)
      VALUES (?, ?, ?)
    `;
    await promisePool.query(query, [matricula, acao, detalhes]);
  } catch (err) {
    console.error('Erro ao registrar auditoria:', err);
  }
}

// Rota de saúde
app.get('/health', async (req, res) => {
  try {
    await promisePool.query('SELECT 1');
    res.status(200).json({ status: 'healthy', database: 'connected' });
  } catch (err) {
    res.status(500).json({ status: 'unhealthy', database: 'disconnected' });
  }
});

// Rota de login
app.post('/login', async (req, res) => {
  const { matricula, senha } = req.body;

  try {
    const [rows] = await promisePool.query('SELECT * FROM users WHERE matricula = ?', [matricula]);

    if (rows.length > 0) {
      const user = rows[0];

      if (senha === user.senha) {
        req.session.user = {
          nome: user.nome,
          matricula: user.matricula,
          cargo: user.cargo,
        };

        res.status(200).json({
          message: 'Login bem-sucedido!',
          user: req.session.user,
        });
      } else {
        res.status(401).json({ message: 'Matrícula ou senha incorretas!' });
      }
    } else {
      res.status(404).json({ message: 'Usuário não encontrado!' });
    }
  } catch (err) {
    res.status(500).json({ message: 'Erro ao conectar ao banco de dados!' });
  }
});

// Rota para servir a página de login
app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// Rota para obter os motoristas
app.get('/api/motoristas', autenticar, async (req, res) => {
  try {
    const [rows] = await promisePool.query("SELECT matricula, nome FROM users WHERE cargo = 'Motorista'");
    res.status(200).json(rows);
  } catch (err) {
    res.status(500).json({ message: 'Erro ao buscar motoristas!' });
  }
});

// Rota para obter as placas dos veículos
app.get('/api/placas', autenticar, async (req, res) => {
  try {
    const [rows] = await promisePool.query('SELECT placa FROM veiculos');
    res.status(200).json(rows);
  } catch (err) {
    res.status(500).json({ message: 'Erro ao buscar placas!' });
  }
});

// Rota para obter os dados da tabela inspecoes
app.get('/api/inspecoes', autenticar, async (req, res) => {
  try {
    const [rows] = await promisePool.query('SELECT * FROM inspecoes');
    res.status(200).json(rows);
  } catch (err) {
    console.error('Erro ao buscar inspeções:', err);
    res.status(500).json({ message: 'Erro ao buscar inspeções!' });
  }
});

// Rota para obter os detalhes de uma inspeção específica
app.get('/api/inspecoes/:id', autenticar, async (req, res) => {
  const { id } = req.params;

  try {
    const [rows] = await promisePool.query('SELECT * FROM inspecoes WHERE id = ?', [id]);

    if (rows.length > 0) {
      res.status(200).json(rows[0]);
    } else {
      res.status(404).json({ message: 'Inspeção não encontrada!' });
    }
  } catch (err) {
    console.error('Erro ao buscar inspeção:', err);
    res.status(500).json({ message: 'Erro ao buscar inspeção!' });
  }
});

// Rota para salvar os dados do checklist
app.post('/api/salvar_inspecao', autenticar, async (req, res) => {
  const {
    matricula,
    placa,
    data_inspecao,
    km_atual,
    horimetro,
    observacoes,
    ...outrosCampos
  } = req.body;

  if (!matricula || !placa || !data_inspecao || !km_atual || !horimetro) {
    return res.status(400).json({ message: 'Dados obrigatórios faltando!' });
  }

  if (km_atual < 0 || horimetro < 0) {
    return res.status(400).json({ message: 'KM atual e horímetro devem ser valores positivos!' });
  }

  try {
    const campos = [
      'matricula', 'placa', 'data_inspecao', 'km_atual', 'horimetro', 'observacoes',
      'buzina', 'cinto_seguranca', 'quebra_sol', 'retrovisor_inteiro', 'retrovisor_direito_esquerdo',
      'limpador_para_brisa', 'farol_baixa', 'farol_alto', 'meia_luz', 'luz_freio', 'luz_re',
      'bateria', 'luzes_painel', 'seta_direita_esquerdo', 'pisca_alerta', 'luz_interna',
      'velocimetro_tacografo', 'freios', 'macaco', 'chave_roda', 'triangulo_sinalizacao',
      'extintor_incendio', 'portas_travas', 'sirene', 'fechamento_janelas', 'para_brisa',
      'oleo_motor', 'oleo_freio', 'nivel_agua_radiador', 'pneus_estado_calibragem',
      'pneu_reserva_estepe', 'bancos_encosto_assentos', 'para_choque_dianteiro',
      'para_choque_traseiro', 'lataria', 'estado_fisico_sky', 'funcionamento_sky',
      'sapatas', 'cestos', 'comandos', 'lubrificacao', 'ensaio_eletrico', 'cilindros',
      'gavetas', 'capas', 'nivel_oleo_sky'
    ];

    const placeholders = campos.map(() => '?').join(', ');
    const values = campos.map(campo => {
      if (campo === 'observacoes') {
        return req.body[campo] || null;
      }
      if (req.body[campo] === undefined) {
        return null;
      }
      return req.body[campo];
    });

    const query = `
      INSERT INTO inspecoes (
        ${campos.join(', ')}
      )
      VALUES (${placeholders})
    `;

    await promisePool.query(query, values);
    await registrarAuditoria(matricula, 'Salvar Inspeção', `Inspeção salva com placa: ${placa}`);

    res.status(201).json({ message: 'Inspeção salva com sucesso!' });
  } catch (err) {
    console.error('Erro ao salvar inspeção:', err);
    res.status(500).json({ message: 'Erro ao salvar inspeção!' });
  }
});

// Rota para filtrar inspeções
app.post('/api/filtrar_inspecoes', autenticar, async (req, res) => {
  const { placa, matricula, dataInicial, dataFinal } = req.body;

  try {
    let query = 'SELECT * FROM inspecoes WHERE 1=1';
    const values = [];
    let index = 1;

    if (placa) {
      query += ` AND placa = ?`;
      values.push(placa);
    }

    if (matricula) {
      query += ` AND matricula = ?`;
      values.push(matricula);
    }

    if (dataInicial && dataFinal) {
      query += ` AND data_inspecao BETWEEN ? AND ?`;
      values.push(dataInicial, dataFinal);
    } else if (dataInicial) {
      query += ` AND data_inspecao >= ?`;
      values.push(dataInicial);
    } else if (dataFinal) {
      query += ` AND data_inspecao <= ?`;
      values.push(dataFinal);
    }

    const [rows] = await promisePool.query(query, values);
    res.status(200).json(rows);
  } catch (err) {
    console.error('Erro ao filtrar inspeções:', err);
    res.status(500).json({ message: 'Erro ao filtrar inspeções!' });
  }
});

// Rota para excluir uma inspeção
app.delete('/api/excluir_inspecao/:id', autenticar, async (req, res) => {
  const { id } = req.params;

  try {
    const [result] = await promisePool.query('DELETE FROM inspecoes WHERE id = ?', [id]);

    if (result.affectedRows > 0) {
      await registrarAuditoria(req.user.matricula, 'Excluir Inspeção', `Inspeção excluída com ID: ${id}`);
      res.status(200).json({ message: 'Inspeção excluída com sucesso!' });
    } else {
      res.status(404).json({ message: 'Inspeção não encontrada!' });
    }
  } catch (err) {
    console.error('Erro ao excluir inspeção:', err);
    res.status(500).json({ message: 'Erro ao excluir inspeção!' });
  }
});

// Rota para carregar a página de edição
app.get('/editar_inspecao', autenticar, (req, res) => {
  res.sendFile(path.join(__dirname, '../public/editar_inspecao.html'));
});

// Rota para obter os dados de uma inspeção específica para edição
app.get('/api/editar_inspecao/:id', autenticar, async (req, res) => {
  const { id } = req.params;

  try {
    const [rows] = await promisePool.query('SELECT * FROM inspecoes WHERE id = ?', [id]);

    if (rows.length > 0) {
      res.status(200).json(rows[0]);
    } else {
      res.status(404).json({ message: 'Inspeção não encontrada!' });
    }
  } catch (err) {
    console.error('Erro ao buscar inspeção:', err);
    res.status(500).json({ message: 'Erro ao buscar inspeção!' });
  }
});

// Rota para salvar as alterações da inspeção editada
app.post('/api/editar_inspecao/:id', autenticar, async (req, res) => {
  const { id } = req.params;
  const { placa, matricula, data_inspecao, km_atual, horimetro, observacoes } = req.body;

  try {
    const query = `
      UPDATE inspecoes
      SET placa = ?, matricula = ?, data_inspecao = ?, km_atual = ?, horimetro = ?, observacoes = ?
      WHERE id = ?
    `;
    const values = [placa, matricula, data_inspecao, km_atual, horimetro, observacoes, id];

    await promisePool.query(query, values);
    await registrarAuditoria(matricula, 'Editar Inspeção', `Inspeção editada com ID: ${id}`);

    res.status(200).json({ message: 'Inspeção atualizada com sucesso!' });
  } catch (err) {
    console.error('Erro ao atualizar inspeção:', err);
    res.status(500).json({ message: 'Erro ao atualizar inspeção!' });
  }
});

// Rota para upload de planilha de transformadores
app.post('/api/upload_transformadores', autenticar, upload.single('planilha'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ message: 'Nenhum arquivo enviado!' });
  }

  try {
    const workbook = xlsx.readFile(req.file.path);
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const data = xlsx.utils.sheet_to_json(sheet);

    console.log('Dados lidos da planilha:', data);

    for (const row of data) {
      const {
        ITEM: item,
        MARCA: marca,
        ' POTÊNCIA (KVA)': potencia,
        'N° DE FASES': numero_fases,
        'N° DE SÉRIE': numero_serie,
        'LOCAL RETIRADA': local_retirada,
        REGIONAL: regional,
        'MOTIVO DA DESATIVAÇÃO': motivo_desativacao,
        'DATA DE ENTRADA NO ALMOXARIFADO (RETIRADA)': data_entrada_almoxarifado,
      } = row;

      if (!item || isNaN(item)) {
        console.error('Erro: O campo "item" está ausente ou não é um número válido na linha:', row);
        continue;
      }

      const dataFormatada = excelSerialDateToJSDate(data_entrada_almoxarifado);

      const [transformadorExistente] = await promisePool.query(
        'SELECT * FROM transformadores WHERE numero_serie = ?',
        [numero_serie]
      );

      if (transformadorExistente.length > 0) {
        await promisePool.query(
          `UPDATE transformadores SET
            item = ?,
            marca = ?,
            potencia = ?,
            numero_fases = ?,
            local_retirada = ?,
            regional = ?,
            motivo_desativacao = ?,
            data_entrada_almoxarifado = ?
          WHERE numero_serie = ?`,
          [
            item,
            marca,
            potencia,
            numero_fases,
            local_retirada,
            regional,
            motivo_desativacao,
            dataFormatada,
            numero_serie,
          ]
        );
      } else {
        await promisePool.query(
          `INSERT INTO transformadores (
            item, marca, potencia, numero_fases, numero_serie, local_retirada, regional, motivo_desativacao, data_entrada_almoxarifado
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            item,
            marca,
            potencia,
            numero_fases,
            numero_serie,
            local_retirada,
            regional,
            motivo_desativacao,
            dataFormatada,
          ]
        );
      }
    }

    await registrarAuditoria(req.user.matricula, 'Upload de Planilha de Transformadores', 'Planilha processada com sucesso');
    res.status(200).json({ message: 'Dados processados com sucesso!' });
  } catch (error) {
    console.error('Erro ao processar planilha:', error);
    res.status(500).json({ message: 'Erro ao processar planilha!' });
  }
});

// Rota para salvar o checklist de transformadores
app.post('/api/salvar_checklist', autenticar, async (req, res) => {
  const {
    numero_serie,
    data_fabricacao,
    reformado,
    data_reformado,
    detalhes_tanque,
    corrosao_tanque,
    buchas_primarias,
    buchas_secundarias,
    conectores,
    avaliacao_bobina_i,
    avaliacao_bobina_ii,
    avaliacao_bobina_iii,
    conclusao,
    transformador_destinado,
    matricula_responsavel,
    observacoes
  } = req.body;

  if (!numero_serie || !data_fabricacao || !matricula_responsavel) {
    return res.status(400).json({ message: 'Campos obrigatórios faltando!' });
  }

  const corrosaoTanque = corrosao_tanque || 'NENHUMA';

  try {
    const [transformadorExistente] = await promisePool.query(
      'SELECT * FROM transformadores WHERE numero_serie = ?',
      [numero_serie]
    );

    if (transformadorExistente.length === 0) {
      return res.status(404).json({ message: 'Transformador não encontrado!' });
    }

    const [responsavelExistente] = await promisePool.query(
      'SELECT * FROM users WHERE matricula = ?',
      [matricula_responsavel]
    );

    if (responsavelExistente.length === 0) {
      return res.status(404).json({ message: 'Responsável técnico não encontrado!' });
    }

    const isReformado = reformado === 'true';

    if (isReformado && !data_reformado) {
      return res.status(400).json({ message: 'Data de reforma é obrigatória para transformadores reformados!' });
    }

    if (isReformado && new Date(data_reformado) <= new Date(data_fabricacao)) {
      return res.status(400).json({ message: 'Data de reforma deve ser posterior à data de fabricação!' });
    }

    const query = `
      INSERT INTO checklist_transformadores (
        numero_serie, data_fabricacao, reformado, data_reformado, detalhes_tanque,
        corrosao_tanque, buchas_primarias, buchas_secundarias, conectores,
        avaliacao_bobina_i, avaliacao_bobina_ii, avaliacao_bobina_iii,
        conclusao, transformador_destinado, matricula_responsavel, observacoes
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    const values = [
      numero_serie,
      data_fabricacao,
      isReformado,
      isReformado ? data_reformado : null,
      detalhes_tanque,
      corrosaoTanque,
      buchas_primarias,
      buchas_secundarias,
      conectores,
      avaliacao_bobina_i,
      avaliacao_bobina_ii,
      avaliacao_bobina_iii,
      conclusao,
      transformador_destinado,
      matricula_responsavel,
      observacoes
    ];

    await promisePool.query(query, values);
    await registrarAuditoria(matricula_responsavel, 'Salvar Checklist', `Checklist salvo para transformador com número de série: ${numero_serie}`);

    res.status(201).json({ message: 'Checklist salvo com sucesso!' });
  } catch (error) {
    console.error('Erro ao salvar checklist:', error);

    if (error.code === 'ER_DUP_ENTRY') {
      return res.status(400).json({ message: 'Já existe um checklist para este transformador!' });
    }

    res.status(500).json({ message: 'Erro ao salvar checklist!' });
  }
});

// Rota para obter os responsáveis técnicos
app.get('/api/responsaveis', autenticar, async (req, res) => {
  try {
    const query = `
      SELECT matricula, nome 
      FROM users 
      WHERE cargo IN ('Engenheiro', 'Técnico', 'Gerente', 'ADMIN', 'ADM')
    `;
    const [rows] = await promisePool.query(query);
    res.status(200).json(rows);
  } catch (err) {
    console.error('Erro ao buscar responsáveis:', err);
    res.status(500).json({ message: 'Erro ao buscar responsáveis técnicos!' });
  }
});

// Rota para obter os supervisores técnicos
app.get('/api/supervisores', autenticar, async (req, res) => {
  try {
    const query = `
      SELECT matricula, nome 
      FROM users 
      WHERE cargo IN ('Engenheiro', 'Gerente')
    `;
    const [rows] = await promisePool.query(query);
    res.status(200).json(rows);
  } catch (err) {
    console.error('Erro ao buscar supervisores:', err);
    res.status(500).json({ message: 'Erro ao buscar supervisores técnicos!' });
  }
});

// Rota para obter o último horímetro de uma placa
app.get('/api/ultimo_horimetro', autenticar, async (req, res) => {
  const { placa } = req.query;

  if (!placa) {
    return res.status(400).json({ message: 'Placa é obrigatória!' });
  }

  try {
    console.log('Buscando horímetro para a placa:', placa);

    const [rows] = await promisePool.query(
      'SELECT horimetro FROM inspecoes WHERE placa = ? ORDER BY data_inspecao DESC LIMIT 1',
      [placa]
    );

    console.log('Resultado da consulta:', rows);

    if (rows.length > 0) {
      res.status(200).json({ horimetro: rows[0].horimetro });
    } else {
      res.status(404).json({ message: 'Nenhuma inspeção encontrada para esta placa.' });
    }
  } catch (error) {
    console.error('Erro ao buscar horímetro:', error);
    res.status(500).json({ message: 'Erro ao buscar horímetro.' });
  }
});

// Rota para filtrar transformadores
app.post('/api/filtrar_transformadores', autenticar, async (req, res) => {
  const { numero_serie, matricula_responsavel, dataInicial, dataFinal } = req.body;

  try {
    let query = `
      SELECT 
        ct.id,
        ct.numero_serie,
        t.potencia,
        ct.data_formulario,
        ct.matricula_responsavel,
        u.nome AS nome_responsavel,
        t.local_retirada,
        t.regional,
        t.numero_fases,
        t.marca,
        t.motivo_desativacao,
        t.data_entrada_almoxarifado
      FROM checklist_transformadores ct
      INNER JOIN transformadores t ON ct.numero_serie = t.numero_serie
      INNER JOIN users u ON ct.matricula_responsavel = u.matricula
      WHERE 1=1
    `;

    const values = [];

    if (numero_serie) {
      query += ` AND ct.numero_serie = ?`;
      values.push(numero_serie);
    }

    if (matricula_responsavel) {
      query += ` AND ct.matricula_responsavel = ?`;
      values.push(matricula_responsavel);
    }

    if (dataInicial && dataFinal) {
      query += ` AND ct.data_formulario BETWEEN ? AND ?`;
      values.push(dataInicial, dataFinal);
    } else if (dataInicial) {
      query += ` AND ct.data_formulario >= ?`;
      values.push(dataInicial);
    } else if (dataFinal) {
      query += ` AND ct.data_formulario <= ?`;
      values.push(dataFinal);
    }

    const [rows] = await promisePool.query(query, values);
    res.status(200).json(rows);
  } catch (err) {
    console.error('Erro ao filtrar transformadores:', err);
    res.status(500).json({ message: 'Erro ao filtrar transformadores!' });
  }
});

// Rota para obter os detalhes de um checklist específico
app.get('/api/checklist_transformadores/:id', autenticar, async (req, res) => {
  const { id } = req.params;

  try {
    const query = `
      SELECT 
        ct.*, 
        t.potencia, 
        t.numero_serie,
        t.local_retirada,
        t.regional,
        t.numero_fases,
        t.marca,
        t.motivo_desativacao,
        t.data_entrada_almoxarifado,
        u.nome AS nome_responsavel,
        ct.supervisor_tecnico AS nome_supervisor
      FROM checklist_transformadores ct
      INNER JOIN transformadores t ON ct.numero_serie = t.numero_serie
      INNER JOIN users u ON ct.matricula_responsavel = u.matricula
      WHERE ct.id = ?
    `;
    const [rows] = await promisePool.query(query, [id]);

    if (rows.length > 0) {
      res.status(200).json(rows[0]);
    } else {
      res.status(404).json({ message: 'Checklist não encontrado!' });
    }
  } catch (err) {
    console.error('Erro ao buscar checklist:', err);
    res.status(500).json({ message: 'Erro ao buscar checklist!' });
  }
});

// Rota pública para a página de relatório de formulário
app.get('/relatorio_publico', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/relatorio_formulario.html'));
});

// Rota para gerar PDF de um checklist específico
app.get('/api/gerar_pdf/:id', async (req, res) => {
  const { id } = req.params;

  try {
    const query = `
      SELECT 
        t.marca,
        t.numero_serie
      FROM checklist_transformadores ct
      INNER JOIN transformadores t ON ct.numero_serie = t.numero_serie
      WHERE ct.id = ?
    `;
    const [rows] = await promisePool.query(query, [id]);

    if (rows.length === 0) {
      return res.status(404).json({ message: 'Checklist não encontrado!' });
    }

    const { marca, numero_serie } = rows[0];
    const marcaFormatada = marca.replace(/[^a-zA-Z0-9]/g, '_');
    const nomeArquivo = `${id}_${numero_serie}_${marcaFormatada}.pdf`;

    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    const url = `http://localhost:${port}/relatorio_publico?id=${id}`;
    
    await page.goto(url, { waitUntil: 'networkidle' });
    const pdfBuffer = await page.pdf({
      format: 'A4',
      printBackground: true,
    });

    await browser.close();

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=${nomeArquivo}`);
    res.send(pdfBuffer);
  } catch (err) {
    console.error('Erro ao gerar PDF com Playwright:', err);
    res.status(500).json({ message: 'Erro ao gerar PDF com Playwright!' });
  }
});

// Rota para obter os logs de auditoria
app.get('/api/auditoria', autenticar, verificarPermissao, async (req, res) => {
  try {
    const [rows] = await promisePool.query('SELECT * FROM auditoria ORDER BY timestamp DESC');
    res.status(200).json(rows);
  } catch (err) {
    console.error('Erro ao buscar logs de auditoria:', err);
    res.status(500).json({ message: 'Erro ao buscar logs de auditoria!' });
  }
});

// Rota para servir a página de auditoria
app.get('/auditoria', autenticar, verificarPermissao, (req, res) => {
  res.sendFile(path.join(__dirname, '../public/auditoria.html'));
});

// Rotas para as páginas
app.get('/dashboard', autenticar, (req, res) => {
  res.sendFile(path.join(__dirname, '../public/dashboard.html'));
});

app.get('/transformadores', autenticar, verificarPermissaoPorCargo, (req, res) => {
  res.sendFile(path.join(__dirname, '../public/transformadores.html'));
});

app.get('/subestacao', autenticar, verificarPermissaoPorCargo, (req, res) => {
  res.sendFile(path.join(__dirname, '../public/subestacao.html'));
});

app.get('/frota', autenticar, verificarPermissaoPorCargo, (req, res) => {
  res.sendFile(path.join(__dirname, '../public/frota.html'));
});

app.get('/checklist_veiculos', autenticar, verificarPermissaoPorCargo, (req, res) => {
  res.sendFile(path.join(__dirname, '../public/checklist_veiculos.html'));
});

app.get('/filtrar_veiculos', autenticar, verificarPermissaoPorCargo, (req, res) => {
  res.sendFile(path.join(__dirname, '../public/filtrar_veiculos.html'));
});

app.get('/relatorio_veiculos', autenticar, verificarPermissaoPorCargo, (req, res) => {
  res.sendFile(path.join(__dirname, '../public/relatorio_veiculos.html'));
});

app.get('/check_horimetro', autenticar, verificarPermissaoPorCargo, (req, res) => {
  res.sendFile(path.join(__dirname, '../public/check_horimetro.html'));
});

app.get('/upload_transformadores', autenticar, verificarPermissaoPorCargo, (req, res) => {
  res.sendFile(path.join(__dirname, '../public/upload_transformadores.html'));
});

app.get('/formulario_transformadores', autenticar, verificarPermissaoPorCargo, (req, res) => {
  res.sendFile(path.join(__dirname, '../public/formulario_transformadores.html'));
});

app.get('/filtrar_transformadores', autenticar, verificarPermissaoPorCargo, (req, res) => {
  res.sendFile(path.join(__dirname, '../public/filtrar_transformadores.html'));
});

app.get('/relatorio_formulario', autenticar, verificarPermissaoPorCargo, (req, res) => {
  res.sendFile(path.join(__dirname, '../public/relatorio_formulario.html'));
});

app.get('/api/checklist_transformadores_publico/:id', async (req, res) => {
  const { id } = req.params;

  try {
    const query = `
      SELECT 
        ct.*, 
        t.potencia, 
        t.numero_serie,
        t.local_retirada,
        t.regional,
        t.numero_fases,
        t.marca,
        t.motivo_desativacao,
        t.data_entrada_almoxarifado,
        u.nome AS nome_responsavel,
        ct.supervisor_tecnico AS nome_supervisor
      FROM checklist_transformadores ct
      INNER JOIN transformadores t ON ct.numero_serie = t.numero_serie
      INNER JOIN users u ON ct.matricula_responsavel = u.matricula
      WHERE ct.id = ?
    `;
    const [rows] = await promisePool.query(query, [id]);

    if (rows.length > 0) {
      res.status(200).json(rows[0]);
    } else {
      res.status(404).json({ message: 'Checklist não encontrado!' });
    }
  } catch (err) {
    console.error('Erro ao buscar checklist:', err);
    res.status(500).json({ message: 'Erro ao buscar checklist!' });
  }
});

app.get('/editar_transformadores', autenticar, verificarPermissaoPorCargo, (req, res) => {
  res.sendFile(path.join(__dirname, '../public/editar_transformadores.html'));
});

app.delete('/api/excluir_transformador/:id', autenticar, async (req, res) => {
  const { id } = req.params;
  console.log(`Tentando excluir transformador com ID: ${id}`);

  try {
    const [result] = await promisePool.query('DELETE FROM checklist_transformadores WHERE id = ?', [id]);
    console.log(`Resultado da exclusão:`, result.affectedRows);

    if (result.affectedRows > 0) {
      await registrarAuditoria(req.user.matricula, 'Excluir Transformador', `Transformador excluído com ID: ${id}`);
      res.status(200).json({ message: 'Transformador excluído com sucesso!' });
    } else {
      res.status(404).json({ message: 'Transformador não encontrado!' });
    }
  } catch (err) {
    console.error('Erro ao excluir transformador:', err);
    res.status(500).json({ message: 'Erro ao excluir transformador!' });
  }
});

app.get('/api/gerar_pdf_veiculos/:id', async (req, res) => {
  const { id } = req.params;

  try {
    const query = `
      SELECT 
        placa
      FROM inspecoes
      WHERE id = ?
    `;
    const [rows] = await promisePool.query(query, [id]);

    if (rows.length === 0) {
      return res.status(404).json({ message: 'Inspeção não encontrada!' });
    }

    const { placa } = rows[0];
    const placaFormatada = placa.replace(/[^a-zA-Z0-9]/g, '_');
    const nomeArquivo = `${id}_${placaFormatada}.pdf`;

    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    const url = `http://localhost:${port}/relatorio_publico_veiculos?id=${id}`;
    
    await page.goto(url, { waitUntil: 'networkidle' });
    const pdfBuffer = await page.pdf({
      format: 'A4',
      printBackground: true,
    });

    await browser.close();

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=${nomeArquivo}`);
    res.send(pdfBuffer);
  } catch (err) {
    console.error('Erro ao gerar PDF com Playwright:', err);
    res.status(500).json({ message: 'Erro ao gerar PDF com Playwright!' });
  }
});

app.get('/relatorio_publico_veiculos', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/relatorio_veiculos.html'));
});

app.get('/api/inspecoes_publico/:id', async (req, res) => {
  const { id } = req.params;

  try {
    const [rows] = await promisePool.query('SELECT * FROM inspecoes WHERE id = ?', [id]);

    if (rows.length > 0) {
      res.status(200).json(rows[0]);
    } else {
      res.status(404).json({ message: 'Inspeção não encontrada!' });
    }
  } catch (err) {
    console.error('Erro ao buscar inspeção:', err);
    res.status(500).json({ message: 'Erro ao buscar inspeção!' });
  }
});

// Iniciar o servidor
app.listen(port, () => {
  console.log(`Servidor rodando em http://localhost:${port}`);
});
