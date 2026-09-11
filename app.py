import os
import re
import string
import random
from flask import Flask, render_template, request
from flask_socketio import SocketIO, join_room, leave_room, emit, rooms

app = Flask(__name__)
app.config['SECRET_KEY'] = os.environ.get('SECRET_KEY', 'fg-call-secret')
socketio = SocketIO(app, cors_allowed_origins="*", async_mode='eventlet')

ROOM_ID_RE = re.compile(r'^[A-Za-z0-9\-]{4,32}$')

# room_id -> set of sids
rooms_state = {}


def gen_room_id(n=8):
    chars = string.ascii_lowercase + string.digits
    return ''.join(random.choice(chars) for _ in range(n))


@app.route('/')
def index():
    return render_template('index.html')


@app.route('/call/<room_id>')
def call(room_id):
    if not ROOM_ID_RE.match(room_id):
        return "Invalid room ID", 400
    return render_template('call.html', room_id=room_id)


@app.route('/api/new-room')
def new_room():
    rid = gen_room_id()
    while rid in rooms_state:
        rid = gen_room_id()
    return {'room_id': rid}


@socketio.on('connect')
def on_connect():
    pass


@socketio.on('join')
def on_join(data):
    room_id = str(data.get('room_id', ''))[:32]
    if not ROOM_ID_RE.match(room_id):
        emit('join_error', {'reason': 'invalid_room'})
        return

    members = rooms_state.get(room_id, set())

    if len(members) >= 2:
        emit('join_error', {'reason': 'room_full'})
        return

    is_initiator = len(members) == 0
    members.add(request.sid)
    rooms_state[room_id] = members
    join_room(room_id)

    emit('joined', {'room_id': room_id, 'initiator': is_initiator})

    if not is_initiator:
        emit('peer_joined', {}, room=room_id, include_self=False)


@socketio.on('signal')
def on_signal(data):
    room_id = str(data.get('room_id', ''))[:32]
    if room_id not in rooms_state or request.sid not in rooms_state[room_id]:
        return
    payload = data.get('payload')
    if payload is None:
        return
    emit('signal', {'payload': payload}, room=room_id, include_self=False)


@socketio.on('leave')
def on_leave(data):
    room_id = str(data.get('room_id', ''))[:32]
    _remove_from_room(room_id, request.sid)


@socketio.on('disconnect')
def on_disconnect():
    for room_id in list(rooms_state.keys()):
        if request.sid in rooms_state[room_id]:
            _remove_from_room(room_id, request.sid)


def _remove_from_room(room_id, sid):
    members = rooms_state.get(room_id)
    if not members or sid not in members:
        return
    members.discard(sid)
    leave_room(room_id, sid=sid)
    emit('peer_left', {}, room=room_id)
    if not members:
        rooms_state.pop(room_id, None)


if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5000))
    socketio.run(app, host='0.0.0.0', port=port)
