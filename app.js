const express = require('express');
const path = require('path');
const dotenv = require('dotenv');
const morgan = require('morgan');
const socketio = require('socket.io');
const jwt = require('jsonwebtoken');
const Automerge = require('@automerge/automerge');
const mongodb = require('./db/mongo');
const mongoose = require('mongoose');
const { User, Doc, Change } = require('./db/mongo_models');
const { body, validationResult } = require('express-validator');

const app = express();
dotenv.config();

app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(morgan('tiny'));

// DB 연결
mongodb.main().catch((err) => console.log(err));

// 유저 정보 등록 api
app.post('/signup', body('username').notEmpty().isString(), body('email').notEmpty().isEmail(), async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.send({ errors: errors.array() });
    }

    const { username, email } = req.body;

    // 중복 이메일 체크
    const foundUser = await User.findOne({ email });
    if (foundUser) {
      return res.status(400).json({ success: false, message: '중복 이메일이 존재합니다.' });
    }

    const token = jwt.sign({ username, email }, process.env.JWT_SECRET, { expiresIn: '1h' });

    // 유저 정보 저장
    await User.create({ username, email });

    /**
     * @typedef {Object} User
     * @property {string} username - 이름
     * @property {string} email - 이메일
     * @property {string} token - 토큰
     */

    /**
     * @param {User}
     */
    const user = { username, email, token };

    return res.status(201).json({ success: true, result: user });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false });
  }
});

app.use((req, res, next) => {
  const error = new Error(`${req.method} ${req.url} 라우터가 없습니다.`);
  error.status = 404;
  next(error);
});

app.use((err, req, res, next) => {
  const message = process.env.NODE_ENV !== 'production' ? err.message : '서버 에러';
  const stack = process.env.NODE_ENV !== 'production' ? err.stack : {};

  res.status(err.status || 500).json({
    message,
    stack,
  });
});

const PORT = process.env.PORT || 8000;

const expressServer = app.listen(PORT, () => {
  console.log(`Listening on port`, PORT);
});

// socke io 연결
const io = socketio(expressServer, {
  path: '/socket.io',
});

/** 접속 유저 정보
 * @param {Array} allUsers - 접속 유저 정보 담긴 배열
 */
const allUsers = [];

// middleware
io.of('/doc').use((socket, next) => {
  const verified = verifyToken(socket.handshake.query.token);
  if (verified) {
    socket.user = { username: verified.username, email: verified.email, token: socket.handshake.query.token };
    next();
  } else {
    socket.disconnect(true);
  }
});

io.of('/doc').on('connection', async (socket) => {
  // update allUsers
  allUsers.push({ socket, user: socket.user });

  /** actorId
   *  @param {string} actorId - 문서 actorId
   */
  const actorId = '0001';

  // 문서 정보 조회
  const foundDoc = await Doc.findOne({ actorId });
  if (!foundDoc) {
    /**
     * @typedef {Object} Doc
     * @property {string} text - 내용
     * @property {number} version - 문서 버전
     */

    /**
     * @param {Doc}
     */
    const doc = Automerge.change(Automerge.init({ actor: actorId }), (doc) => {
      doc.text = new Automerge.Text(process.env.DOC_TEXT);
      doc.version = new Automerge.Counter(0);
    });

    /**
     * @param {buffer} binaryDoc - doc 바이너리 데이터
     * */
    const binaryDoc = Buffer.from(Automerge.save(doc));

    socket.emit('sendCurrentDocData', { data: binaryDoc });

    // doc 바이너리 데이터 저장
    await Doc.create({ actorId, data: binaryDoc });
  } else {
    socket.emit('sendCurrentDocData', { data: foundDoc.data });
  }

  // 현재 문서 정보 조회 listener
  socket.on('getCurrentDocInfo', async () => {
    if (verifyToken(socket.handshake.query.token)) {
      const foundDoc = await Doc.findOne({ actorId });

      socket.emit('sendCurrentDocData', { data: foundDoc.data });
    } else {
      socket.disconnect(true);
    }
  });

  /**
   * @typedef {object} Change
   * @property {string} type - 이벤트 타입
   * @property {string | undefined} insertString - 삽입 문자열
   * @property {number | undefined} deleteLength - 삭제 문자열 길이
   * @property {number} positionIndex - 커서 위치
   */

  /**
   * @param {Change} data
   */
  // 문서 문자열 삽입 & 삭제 listener
  socket.on('changeDocText', async (data) => {
    if (verifyToken(socket.handshake.query.token)) {
      const [foundDoc, user] = await Promise.all([Doc.findOne({ actorId }), User.findOne({ email: socket.user.email })]);

      const currentDoc = Automerge.load(new Uint8Array(foundDoc.data), { actor: actorId });

      let changedDoc;

      if (data.type === 'insert') {
        changedDoc = Automerge.change(Automerge.clone(currentDoc, { actor: actorId }), (doc) => {
          data.insertString.split('').forEach((c, idx) => {
            doc.text.insertAt(data.positionIndex + idx, c);
          });
          doc.version.increment();
        });
      }

      if (data.type === 'delete') {
        changedDoc = Automerge.change(Automerge.clone(currentDoc, { actor: actorId }), (doc) => {
          for (let idx = 0; idx < data.deleteLength; idx++) {
            if (data.positionIndex - idx < 0) {
              break;
            }
            doc.text.deleteAt(data.positionIndex - idx);
          }
          doc.version.increment();
        });
      }

      // 변경 사항 반영
      const changes = Automerge.getChanges(currentDoc, changedDoc);
      [changedDoc] = Automerge.applyChanges(currentDoc, changes);

      // 문서 정보 저장
      const session = await mongoose.startSession();

      /**
       * @param {buffer} binaryDoc = doc 바이너리 데이터
       * */
      const binaryDoc = Buffer.from(Automerge.save(changedDoc));

      try {
        session.startTransaction();

        // 변경 사항 저장
        await Change.create({
          userId: user.id,
          type: data.type,
          insertString: data.insertString,
          deleteLength: data.deleteLength,
          positionIndex: data.positionIndex,
        });

        // doc 바이너리 데이터 저장
        await Doc.updateOne({ actorId: Automerge.getActorId(changedDoc) }, { data: binaryDoc });

        await session.commitTransaction();
      } catch (err) {
        console.log('transaction error', err);
      } finally {
        await session.endSession();
      }

      io.of('/doc').emit('sendCurrentDocData', { data: binaryDoc });
    } else {
      socket.disconnect(true);
    }
  });

  socket.on('disconnect', () => {
    allUsers.forEach((user, idx) => {
      if (user.socket.id === socket.id) {
        allUsers.splice(idx, 1);
      }
    });
  });
});

/** jwt 토큰 유효성 검증
 * @param {string} token - 유저 jwt 토큰
 */
function verifyToken(token) {
  try {
    const result = jwt.verify(token, process.env.JWT_SECRET);
    console.log('Authenticated');
    return result;
  } catch (error) {
    console.log('Non Authenticated');
    return false;
  }
}
