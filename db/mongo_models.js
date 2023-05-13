const { Schema, default: mongoose } = require('mongoose');

const UserSchema = new Schema(
  {
    username: {
      type: String,
      required: true,
    },
    email: {
      type: String,
      required: true,
    },
  },
  {
    timestamps: true,
  },
);

const DocSchema = new Schema({
  actorId: {
    type: String,
    required: true,
  },
  data: Buffer,
});

const ChangeSchema = new Schema(
  {
    userId: {
      type: String,
      ref: 'User',
      required: true,
    },
    type: {
      type: String,
      required: true,
    },
    insertString: {
      type: String,
    },
    deleteLength: {
      type: Number,
    },
    positionIndex: {
      type: Number,
      required: true,
    },
  },
  {
    timestamps: true,
  },
);

const User = mongoose.model('User', UserSchema);
const Doc = mongoose.model('Doc', DocSchema);
const Change = mongoose.model('Change', ChangeSchema);

module.exports = {
  User,
  Doc,
  Change,
};
