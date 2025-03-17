const express = require('express');
const mysql = require('mysql2');
const session = require('express-session');
const bcrypt = require('bcrypt');
const dotenv = require('dotenv');
const app = express();


const db = mysql.createConnection({
    host: process.env.DB_HOST,       // Your DB host (Aiven's MySQL host)
    user: process.env.DB_USER,       // Your DB user
    password: process.env.DB_PASSWORD, // Your DB password
    database: process.env.DB_NAME,   // Your DB name
    port: process.env.DB_PORT,       // Port from Aiven (e.g., 12515)
    ssl: {
      rejectUnauthorized: false,
    }
});

db.connect(err => {
    if (err) {
        console.error('Error connecting to the database: ', err);
        return;
    }
    console.log('Connected to the database!');
});


// Middleware setup
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.set('view engine', 'ejs');
app.use(express.static('public'));

app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: true,
  cookie: { maxAge: 3600000 }, // 1 hour
}));

// Home Route (Displays username and logout button)
app.get('/', (req, res) => {
  if (!req.session.user_id) {
    return res.redirect('/login');
  }

  const user_id = req.session.user_id;

  // Fetch all rooms from the room table
  db.query(`
    SELECT r.room_id, r.name
    FROM room r
  `, (err, result) => {
    if (err) {
      console.log('Database error', err);
      return res.status(500).json({ error: 'Database error' });
    }

    console.log('All Chat Groups:', result); // Log the chat rooms

    // Render the page with all chat groups and pass user_id to the template
    res.render('index', {
      username: req.session.username,
      chatGroups: result,
      user_id: user_id,  // Pass user_id to the template
    });
  });
});

// User Login Page
app.get('/login', (req, res) => {
  res.render('login');
});

app.post('/login', (req, res) => {
  console.log('Login route hit');
  const { email, password } = req.body;

  db.query('SELECT * FROM user WHERE email = ?', [email], (err, result) => {
    if (err) {
      console.error('Database error:', err);
      return res.status(500).json({ error: 'Database error', details: err });
    }

    console.log('Query result:', result);  // This will show the query result
    if (result.length > 0) {
      const user = result[0];

      bcrypt.compare(password, user.password_hash, (err, isMatch) => {
        if (err) {
          console.error('Password comparison error:', err);
          return res.status(500).json({ error: 'Password comparison error', details: err });
        }

        console.log('Password comparison result:', isMatch);  // Log the result of bcrypt comparison

        if (isMatch) {
          req.session.user_id = user.user_id;
          req.session.username = user.username;
          return res.redirect('/');
        } else {
          return res.render('login', { error: 'Incorrect password' });
        }
      });
    } else {
      return res.render('login', { error: 'User not found' });
    }
  });
});

// Sign Up Page
app.get('/signup', (req, res) => {
  res.render('signup');
});

// User Sign Up Post Route
app.post('/signup', (req, res) => {
  const { email, username, password } = req.body;

  // Password validation regex
  const passwordRegex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[\W_]).{10,}$/;

  if (!passwordRegex.test(password)) {
    return res.render('signup', { error: 'Password must be at least 10 characters long and include an uppercase letter, a lowercase letter, a number, and a special character.' });
  }

  bcrypt.hash(password, 10, (err, hashedPassword) => {
    if (err) {
      console.error('Error hashing password:', err);
      return res.status(500).json({ error: 'Error hashing password' });
    }

    db.query('SELECT * FROM user WHERE email = ?', [email], (err, result) => {
      if (err) {
        console.error('Error checking if email exists:', err);
        return res.status(500).json({ error: 'Error checking if email exists', details: err });
      }

      if (result.length > 0) {
        return res.render('signup', { error: 'Email already in use' });
      }

      // If email is unique, insert the new user
      db.query('INSERT INTO user (email, username, password_hash) VALUES (?, ?, ?)', 
        [email, username, hashedPassword], (err, result) => {
          if (err) {
            console.error('Database error during signup:', err);
            return res.status(500).json({ error: 'Database error during signup', details: err });
          }

          res.redirect('/login');
        });
    });
  });
});



// Log out route (destroy session)
app.get('/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      return res.status(500).json({ error: 'Could not log out' });
    }
    res.redirect('/login');
  });
});

// Chat Group Page (Show all messages in the room)
app.get("/chat/:room_id", (req, res) => {
  const roomId = req.params.room_id;

  const query = `
      SELECT m.message_id, m.text, m.sent_datetime, u.username
      FROM message m
      JOIN room_user ru ON m.room_user_id = ru.room_user_id
      JOIN user u ON ru.user_id = u.user_id
      WHERE ru.room_id = ?
      ORDER BY m.sent_datetime ASC;
  `;

  db.query(query, [roomId], (err, messages) => {
    if (err) {
      console.error("Error fetching messages:", err);
      return res.status(500).send("Database error");
    }
    console.log("Messages fetched:", messages); // Debugging log
    res.render("chat", {
      messages: messages,
      room_id: roomId,
      username: req.session.username
    });
  });
});

// Update last_read_message_id when the user reads the latest message
app.post('/read-message/:room_id/:message_id', (req, res) => {
  const user_id = req.session.user_id;
  const room_id = req.params.room_id;
  const message_id = req.params.message_id;

  if (!user_id) {
    return res.status(403).json({ error: 'You need to be logged in to read a message' });
  }

  // Update the last_read_message_id for the user in the room
  db.query(`
    UPDATE room_user 
    SET last_read_message_id = ? 
    WHERE user_id = ? AND room_id = ?
  `, [message_id, user_id, room_id], (err, result) => {
    if (err) {
      console.log('Error updating last_read_message_id:', err);
      return res.status(500).json({ error: 'Database error' });
    }

    // After updating, redirect back to the chat page or do other necessary actions
    res.redirect(`/chat/${room_id}`);
  });
});

// Join a chat group
app.post('/join-chat/:room_id', (req, res) => {
  const user_id = req.session.user_id;
  const room_id = req.params.room_id;

  if (!user_id) {
    return res.status(403).json({ error: 'You need to be logged in to join a chat' });
  }

  // Check if the user is already in the room
  db.query('SELECT * FROM room_user WHERE user_id = ? AND room_id = ?', [user_id, room_id], (err, result) => {
    if (err) {
      console.log('Error checking room_user:', err);
      return res.status(500).json({ error: 'Database error' });
    }

    if (result.length === 0) {
db.query(`
  INSERT INTO room_user (room_id, user_id, last_read_message_id)
  VALUES (?, ?, ?)
`, [room_id, user_id, 0], (err, result) => {  
  if (err) {
    console.log('Error inserting into room_user:', err);
    return res.status(500).json({ error: 'Database error' });
  }

  res.redirect(`/chat/${room_id}`);
});

    } else {
      // If the user is already in the room, just redirect to the chat page
      res.redirect(`/chat/${room_id}`);
    }
  });
});

app.post('/send-message/:room_id', (req, res) => {
  const user_id = req.session.user_id;
  const room_id = req.params.room_id;
  const { message } = req.body;

  if (!user_id) {
    return res.status(403).json({ error: 'You need to be logged in to send a message' });
  }

  db.query(`
    SELECT room_user_id FROM room_user WHERE room_id = ? AND user_id = ?
  `, [room_id, user_id], (err, result) => {
    if (err) {
      console.log('Error fetching room_user_id:', err);
      return res.status(500).json({ error: 'Database error' });
    }

    if (result.length > 0) {
      const room_user_id = result[0].room_user_id;

      // Insert the message into the message table using room_user_id
      db.query(`
        INSERT INTO message (room_user_id, text, sent_datetime)
        VALUES (?, ?, NOW())
      `, [room_user_id, message], (err, result) => {
        if (err) {
          console.log('Error inserting message:', err);
          return res.status(500).json({ error: 'Database error' });
        }

        // After sending the message, redirect to the chat room
        res.redirect(`/chat/${room_id}`);
      });
    } else {
      return res.status(404).json({ error: 'Room or user not found' });
    }
  });
});


app.get('/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      return res.status(500).json({ error: 'Could not log out' });
    }
    res.redirect('/login');  
  });
});


const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
