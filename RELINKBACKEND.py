from flask import Flask, send_from_directory, request
from flask_socketio import SocketIO, join_room, leave_room, emit

app = Flask(__name__, static_folder='public')
socketio = SocketIO(app, cors_allowed_origins="*")  # allow all origins

rooms = {}

@app.route('/')
def index():
    return send_from_directory('public', 'index.html')

@socketio.on('setUsername')
def handle_set_username(name):
    emit('usernameSet')

@socketio.on('createRoom')
def handle_create_room(room_name):
    join_room(room_name)
    if room_name not in rooms:
        rooms[room_name] = []
    rooms[room_name].append(request.sid)
    emit('roomJoined', room_name)
    emit('userList', rooms[room_name], room=room_name)

@socketio.on('sendMessage')
def handle_message(msg):
    for room_name, users in rooms.items():
        if request.sid in users:
            emit('newMessage', {'username': 'User', 'msg': msg}, room=room_name)

@socketio.on('disconnect')
def handle_disconnect():
    for room_name, users in rooms.items():
        if request.sid in users:
            users.remove(request.sid)
            emit('userList', users, room=room_name)

if __name__ == '__main__':
    socketio.run(app, host='0.0.0.0', port=int(os.environ.get('PORT', 5000)))