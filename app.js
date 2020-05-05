mdc.ripple.MDCRipple.attachTo(document.querySelector('.mdc-button'));

const configuration = {
  iceServers: [
    {
      urls: [
        'stun:stun1.l.google.com:19302',
        'stun:stun2.l.google.com:19302',
      ],
    },
  ],
  iceCandidatePoolSize: 10,
};

let connectedUsers = {};

let localStream = null;

let roomId = null;
let roomRef = null;
let userId = null;

async function init() {

  await openUserMedia();
  document.querySelector('#hangupBtn').addEventListener('click', await hangUp);
  document.querySelector('#createBtn').addEventListener('click', createRoom);
  // document.querySelector('#joinBtn').addEventListener('click', joinRoom);

  var url = new URL(window.location.href);
  var roomParam = url.searchParams.get("room");
  if (roomParam) {
    await joinRoomById(roomParam)
  }

}

async function createRoom() {
  userId = 0;
  document.querySelector('#createBtn').disabled = true;
  document.querySelector('body').classList.add("in-call")


  const db = firebase.firestore();
  roomRef = await db.collection('rooms').doc();

  await roomRef.set({
    nextUserId: 1
  })

  await roomRef.collection('activeUsers').doc(`user${userId}`).set({ 'userId': userId });

  console.log("room id: ", roomRef.id)

  // copy room url
  copyText = document.getElementById("currentRoomHidden");
  copyText.type = "text"
  copyText.value = `${location.protocol}//${location.host}${location.pathname}?room=${roomRef.id}`
  copyText.select();
  document.execCommand("copy")
  copyText.type = "hidden"
  alert("Room url copied. Share with your peer to join")


  await listenNewConnections();

}


async function joinRoomById(roomId) {

  const db = firebase.firestore();
  roomRef = db.collection('rooms').doc(`${roomId}`);
  const roomSnapshot = await roomRef.get();
  console.log('Got room:', roomSnapshot.exists);

  if (roomSnapshot.exists) {
    userId = roomSnapshot.data().nextUserId;

    await roomRef.update({ 'nextUserId': userId + 1 })

    document.querySelector('#createBtn').disabled = true;
    document.querySelector('body').classList.add('in-call')
    document.querySelector(
      '#currentRoom').innerText = `Current room: ${roomId}`;

    await registerNewConnections();

    await roomRef.collection('activeUsers').doc(`user${userId}`).set({ 'userId': userId });

    await listenNewConnections();


  } else {
    alert("Room not found!")
    window.location = `${location.protocol}//${location.host}${location.pathname}`
  }
}


async function openUserMedia(e) {

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia(
      { video: true, audio: true });
    document.querySelector('#createBtn').disabled = false;
  } catch (e) {
    console.log(e)
    alert(`Permission denied. Refresh to try again.`)
    throw new Error("Something went badly wrong!");
  }

  document.querySelector('#localVideo').srcObject = stream;
  localStream = stream;

  console.log('Stream:', document.querySelector('#localVideo').srcObject);
}



async function listenNewConnections() {
  roomRef.collection('connections').onSnapshot(snapshot => {
    snapshot.docChanges().forEach(async change => {
      if (change.type === 'added') {
        let data = change.doc.data();
        if (data.to === userId) {

          const remoteStream = new MediaStream();
          const videoElement = document.createElement('video');
          videoElement.id = `remoteVideo-user${data.from}`;
          videoElement.autoplay = true;
          document.querySelector('#videos').appendChild(videoElement);
          document.querySelector(`#remoteVideo-user${data.from}`).srcObject = remoteStream;

          connectedUsers[data.from] = {};
          connectedUsers[data.from].remoteTrack = remoteStream


          console.log('Create PeerConnection with configuration: ', configuration);
          const peerConnection = new RTCPeerConnection(configuration);



          const connectionsCollection = roomRef.collection('connections');
          const connectionRef = connectionsCollection.doc(`user${data.from}user${userId}`);


          registerPeerConnectionListeners(peerConnection, data.from);

          localStream.getTracks().forEach(track => {
            peerConnection.addTrack(track, localStream);
          });


          // listening for remote tracks
          peerConnection.addEventListener('track', event => {
            console.log('Got remote track:', event.streams[0]);
            event.streams[0].getTracks().forEach(track => {
              console.log('Add a track to the remoteStream:', track);
              connectedUsers[data.from].remoteTrack.addTrack(track);
            });
          });



          // Code for collecting ICE candidates below
          const calleeCandidatesCollection = connectionRef.collection('calleeCandidates');
          peerConnection.addEventListener('icecandidate', event => {
            if (!event.candidate) {
              console.log('Got final candidate!');
              return;
            }
            console.log('Got candidate: ', event.candidate);
            calleeCandidatesCollection.add(event.candidate.toJSON());
          });



          // Code for receiving offer and then creating and sending SDP answer below
          const connectionSnapshot = await connectionRef.get()
          const offer = connectionSnapshot.data().offer
          console.log('Got offer:', offer);
          await peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
          const answer = await peerConnection.createAnswer();
          console.log('Created answer:', answer);
          await peerConnection.setLocalDescription(answer);
          const roomWithAnswer = {
            answer: {
              type: answer.type,
              sdp: answer.sdp,
            },
          };
          await connectionRef.update(roomWithAnswer);


          // Listening for remote ICE candidates below
          connectionRef.collection('callerCandidates').onSnapshot(snapshot => {
            snapshot.docChanges().forEach(async change => {
              if (change.type === 'added') {
                let data = change.doc.data();
                console.log(`Got new remote ICE candidate: ${JSON.stringify(data)}`);
                await peerConnection.addIceCandidate(new RTCIceCandidate(data));
              }
            });
          });

          connectedUsers[data.from].peerConnection = peerConnection


        }
      }
    });
  })
}


async function registerNewConnections() {
  const activeUsers = await roomRef.collection('activeUsers').get();
  activeUsers.forEach(async userSnap => {
    const activeUser = userSnap.data();

    const remoteStream = new MediaStream();
    const videoElement = document.createElement('video');
    videoElement.id = `remoteVideo-user${activeUser.userId}`;
    videoElement.autoplay = true;
    document.querySelector('#videos').appendChild(videoElement);
    document.querySelector(`#remoteVideo-user${activeUser.userId}`).srcObject = remoteStream;

    connectedUsers[activeUser.userId] = {};
    connectedUsers[activeUser.userId].remoteTrack = remoteStream


    console.log('Create PeerConnection with configuration: ', configuration);
    const peerConnection = new RTCPeerConnection(configuration);


    const connectionsCollection = roomRef.collection('connections');
    const connectionRef = connectionsCollection.doc(`user${userId}user${activeUser.userId}`);

    registerPeerConnectionListeners(peerConnection, activeUser.userId);

    // ====================
    //      SENDING
    // ====================

    // setting local track in connection
    localStream.getTracks().forEach(track => {
      peerConnection.addTrack(track, localStream);
    });

    // Code for collecting and storing caller's ICE candidates below
    const callerCandidatesCollection = connectionRef.collection('callerCandidates');
    peerConnection.addEventListener('icecandidate', event => {
      if (!event.candidate) {
        console.log('Got final candidate!');
        return;
      }
      console.log('Got candidate: ', event.candidate);
      callerCandidatesCollection.add(event.candidate.toJSON());
    });


    // Code for creating and storing offer
    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);
    console.log('Created offer:', offer);
    const connectionWithOffer = {
      'offer': {
        type: offer.type,
        sdp: offer.sdp,
      },
      'from': userId,
      'to': activeUser.userId
    };
    await connectionRef.set(connectionWithOffer);


    // ====================
    //      RECEIVING
    // ====================


    // listening for remote tracks
    peerConnection.addEventListener('track', event => {
      console.log('Got remote track:', event.streams[0]);
      event.streams[0].getTracks().forEach(track => {
        console.log('Add a track to the remoteStream:', track);
        connectedUsers[activeUser.userId].remoteTrack.addTrack(track);
      });
    });


    // Listening for remote session description (answer) below
    connectionRef.onSnapshot(async snapshot => {
      const data = snapshot.data();
      if (!peerConnection.currentRemoteDescription && data && data.answer) {
        console.log('Got remote description: ', data.answer);
        const rtcSessionDescription = new RTCSessionDescription(data.answer);
        await peerConnection.setRemoteDescription(rtcSessionDescription);
      }
    });

    // Listen for remote ICE candidates below
    connectionRef.collection('calleeCandidates').onSnapshot(snapshot => {
      snapshot.docChanges().forEach(async change => {
        if (change.type === 'added') {
          let data = change.doc.data();
          console.log(`Got new remote ICE candidate: ${JSON.stringify(data)}`);
          await peerConnection.addIceCandidate(new RTCIceCandidate(data));
        }
      });
    });


    connectedUsers[activeUser.userId].peerConnection = peerConnection



    // for each active user ends here
  })
}



async function hangUp() {

  const tracks = document.querySelector('#localVideo').srcObject.getTracks();
  tracks.forEach(track => {
    track.stop();
  });

  Object.keys(connectedUsers).forEach(user => {
    if (connectedUsers[user].remoteStream) connectedUsers[user].remoteStream.getTracks().forEach(track => track.stop());
    if (connectedUsers[user].peerConnection) connectedUsers[user].peerConnection.close()
    console.log(`closing connection with ${user}`)
  })


  const activeUserSnap = await roomRef.collection('activeUsers').get()
  if (activeUserSnap.size == 1) {

    // if only one member is left, delete room
    roomRef.delete()
      .then(() => {
        alert("room deleted")
        window.location = `${location.protocol}//${location.host}${location.pathname}`
      })

  } else {

    // many members are left, just remove this user
    roomRef.collection('activeUsers').doc(`user${userId}`).delete()
      .then(() => {
        window.location = `${location.protocol}//${location.host}${location.pathname}`
      })

  }

}

function registerPeerConnectionListeners(peerConnection, id) {
  peerConnection.addEventListener('icegatheringstatechange', () => {
    console.log(
      `ICE gathering state changed: ${peerConnection.iceGatheringState}`);
  });

  peerConnection.addEventListener('connectionstatechange', () => {
    console.log(`Connection state change: ${peerConnection.connectionState}`);
    if (peerConnection.connectionState === "disconnected") {
      document.querySelector(`#remoteVideo-user${id}`).remove()
    }
  });

  peerConnection.addEventListener('signalingstatechange', () => {
    console.log(`Signaling state change: ${peerConnection.signalingState}`);
  });

  peerConnection.addEventListener('iceconnectionstatechange ', () => {
    console.log(
      `ICE connection state change: ${peerConnection.iceConnectionState}`);
  });
}


init();